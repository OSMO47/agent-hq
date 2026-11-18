import { spawnSync } from 'node:child_process';
import { type DB, audit, tx } from '../db.ts';
import { createTask, TaskError } from './tasks.ts';
import { projectWorkspace, buildSpec, type AgentRow } from './taskRunner.ts';
import type { SessionManager, SessionStatus } from '../runtime/sessionManager.ts';

export interface PlannedTask {
  title: string; description: string; assignee: string; priority?: number; dependsOn?: number[];
}
export interface Plan { summary: string; tasks: PlannedTask[] }

/** Extract the plan JSON from the CEO's reply (prefers a ```json fenced block, falls back to the last {...}). */
export function parsePlan(text: string): Plan | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = fenced.length ? fenced.reverse() : [text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    try {
      const o = JSON.parse(c.trim());
      if (Array.isArray(o.tasks) && o.tasks.every((t: any) => typeof t.title === 'string')) {
        return { summary: String(o.summary ?? ''), tasks: o.tasks };
      }
    } catch { /* try next */ }
  }
  return null;
}

/** Uncommitted changes in a git workspace (null = not a git repo). Lets the UI warn before agents edit files. */
export function gitDirty(dir: string): { files: number } | null {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (r.status !== 0) return null;
  return { files: r.stdout.split('\n').filter(Boolean).length };
}

function planningPrompt(db: DB, brief: string, projectName: string): string {
  const roster = db.prepare(`SELECT a.id, a.role, a.level, a.model_mode, d.name dept FROM agents a LEFT JOIN departments d ON d.id = a.department_id
                             WHERE a.status = 'active' AND a.level > 1 ORDER BY a.level, a.rowid`).all() as any[];
  return [
    `# Owner brief for project "${projectName}"`, brief, '',
    'The project files are in your current directory. Inspect them (Read/Glob/Grep) as much as needed to understand the codebase before planning. Do NOT modify anything.',
    '', '## Your organization (assign by id)',
    ...roster.map((a) => `- ${a.id} — ${a.role} (${a.dept ?? 'Executive'}${a.level === 2 ? ', leader' : ''})`),
    '', '## Rules',
    '- Break the work into 2–8 concrete tasks a single specialist can finish in one session of about 20 tool turns. Split anything bigger; small tasks are cheaper than one task that runs out of turns.',
    '- Name the files or areas involved so the specialist does not have to search the whole project.',
    '- Each description must be self-contained: goal, relevant files, acceptance criteria.',
    '- Any visual design / UX / UI work goes to ui-ux-designer (or ux-researcher for research).',
    '- Use dependsOn (0-based indexes of earlier tasks) so work that needs other work waits for it. Independent tasks may run in parallel.',
    '- Include a QA task that verifies the result when code changes.',
    '- Do not set difficulty: department leaders rate it.',
    '- priority: 0 (urgent) … 4 (low), default 2.',
    '', 'Finish with ONLY this JSON in a ```json block:',
    '```json\n{"summary":"<2-3 sentences: understanding + approach>","tasks":[{"title":"","description":"","assignee":"<agent id>","priority":2,"dependsOn":[]}]}\n```',
  ].join('\n');
}

/**
 * CEO intake: owner brief → CEO session (read-only tools inside the project) → JSON plan → tasks
 * created as ASSIGNED with dependencies. The owner then runs them (or "Run all ready").
 */
export class CeoPlanner {
  private readonly db: DB;
  private readonly sm: SessionManager;
  private readonly dataDir: string;
  private readonly onPlanned: (projectId: string) => void;

  constructor(db: DB, sm: SessionManager, dataDir: string, onPlanned: (projectId: string) => void) {
    this.db = db; this.sm = sm; this.dataDir = dataDir; this.onPlanned = onPlanned;
    sm.on('status', (id: string, status: SessionStatus) => this.onStatus(id, status));
  }

  brief(projectId: string, text: string, actor: string): string {
    if (!text.trim()) throw new TaskError('brief is empty');
    const p = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as { id: string; name: string } | undefined;
    if (!p) throw new TaskError('project not found');
    const busy = this.db.prepare("SELECT id FROM sessions WHERE project_id = ? AND purpose = 'plan' AND status IN ('queued','starting','running')").get(projectId);
    if (busy) throw new TaskError('the CEO is already planning this project');
    const ceo = this.db.prepare("SELECT * FROM agents WHERE id = 'ceo'").get() as unknown as AgentRow;
    if (ceo.status !== 'active') throw new TaskError('the CEO is suspended');

    const cwd = projectWorkspace(this.db, this.dataDir, projectId);
    const spec = { ...buildSpec(ceo, planningPrompt(this.db, text, p.name), cwd, 25),
      tools: ['Read', 'Glob', 'Grep'], allowedTools: ['Read', 'Glob', 'Grep'], disallowedTools: [] as string[] };
    const sid = this.sm.enqueue({ agentId: 'ceo', actor, spec, purpose: 'plan', projectId });
    this.db.prepare("INSERT INTO messages (from_id, to_id, kind, project_id, body) VALUES (?, 'ceo', 'delegation', ?, ?)").run(actor, projectId, text);
    audit(this.db, actor, 'project.brief', projectId, { sessionId: sid });
    return sid;
  }

  private onStatus(sessionId: string, status: SessionStatus) {
    const s = this.sm.get(sessionId) as any;
    if (!s || s.purpose !== 'plan' || !['completed', 'failed', 'timeout', 'stopped', 'interrupted'].includes(status)) return;
    if (status !== 'completed') {
      this.report(s.project_id, `Planning ${status}. Nothing was created.`);
      return;
    }
    const plan = parsePlan(s.result_text ?? '');
    if (!plan || plan.tasks.length === 0) {
      this.report(s.project_id, `I could not produce a readable plan. Raw answer:\n\n${(s.result_text ?? '').slice(0, 2000)}`);
      return;
    }
    const valid = new Set((this.db.prepare("SELECT id FROM agents WHERE status = 'active'").all() as { id: string }[]).map((r) => r.id));
    const ids: string[] = [];
    tx(this.db, () => {
      plan.tasks.forEach((t, i) => {
        const deps = (t.dependsOn ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d < i).map((d) => ids[d]);
        const created = createTask(this.db, {
          projectId: s.project_id, title: t.title.slice(0, 200), description: String(t.description ?? ''),
          assigneeId: valid.has(t.assignee) ? t.assignee : undefined,
          priority: Number.isInteger(t.priority) && t.priority! >= 0 && t.priority! <= 4 ? t.priority : 2,
          dependsOn: deps, actor: 'ceo',
        });
        ids.push(created.id);
      });
    });
    this.report(s.project_id, `${plan.summary}\n\nCreated ${ids.length} task(s).`);
    audit(this.db, 'ceo', 'project.plan', s.project_id, { tasks: ids.length, sessionId });
    this.onPlanned(s.project_id);
  }

  private report(projectId: string, body: string) {
    this.db.prepare("INSERT INTO messages (from_id, to_id, kind, project_id, body) VALUES ('ceo', 'owner', 'report', ?, ?)").run(projectId, body);
    this.onPlanned(projectId);
  }
}
