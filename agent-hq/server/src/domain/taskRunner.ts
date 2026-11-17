import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type DB, newId, audit, getPolicy } from '../db.ts';
import { claimTask, transition, getTask, TaskError, type Task, type Difficulty, DIFFICULTIES } from './tasks.ts';
import type { SessionManager, SessionStatus } from '../runtime/sessionManager.ts';
import type { RunSpec } from '../runtime/types.ts';

export interface AgentRow {
  id: string; name: string; role: string; level: number; department_id: string | null; model: string;
  model_mode: 'difficulty' | 'fixed'; instructions: string; permissions: string; status: string; workspace: string | null;
}

/** Workspace for a project: its repo if configured, else ./data/workspaces/<projectId>. Agents get nothing outside it. */
export function projectWorkspace(db: DB, dataDir: string, projectId: string): string {
  const p = db.prepare('SELECT repo_path FROM projects WHERE id = ?').get(projectId) as { repo_path: string | null } | undefined;
  if (!p) throw new TaskError(`project ${projectId} not found`);
  const dir = p.repo_path ? resolve(p.repo_path) : join(dataDir, 'workspaces', projectId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const DEFAULT_DIFFICULTY_MODELS = { easy: 'haiku', medium: 'sonnet', hard: 'opus' };

/**
 * Which model runs a task:
 *  1. agent.model_mode = 'fixed' (e.g. UI/UX design) → always the agent's model;
 *  2. task difficulty → owner policy map;
 *  3. otherwise the agent's model.
 */
export function modelFor(db: DB, task: Pick<Task, 'difficulty'>, agent: Pick<AgentRow, 'model' | 'model_mode'>): string {
  if (agent.model_mode === 'fixed' || !task.difficulty) return agent.model;
  const map = getPolicy<Record<string, string>>(db, 'models.byDifficulty', DEFAULT_DIFFICULTY_MODELS);
  return map[task.difficulty] ?? agent.model;
}

export function buildSpec(agent: AgentRow, prompt: string, cwd: string, maxTurns: number): RunSpec {
  const perm = JSON.parse(agent.permissions || '{}');
  return {
    prompt, cwd, model: agent.model, maxTurns,
    systemPrompt: `You are ${agent.name}, ${agent.role}, in an AI organization run by a human owner.\n${agent.instructions}`,
    tools: perm.tools, allowedTools: perm.allowedTools, disallowedTools: perm.disallowedTools,
    permissionMode: perm.permissionMode ?? 'default',
  };
}

const ESCALATE_HINT = 'If this task turns out to be clearly harder than expected for you, stop early and make the LAST line of your reply exactly:\nESCALATE: <one-sentence reason>\nThe task will continue on a stronger model with this conversation.';

function taskPrompt(db: DB, taskId: string, canEscalate: boolean): string {
  const t = getTask(db, taskId)!;
  const comments = db.prepare('SELECT author, body FROM task_comments WHERE task_id = ? ORDER BY id').all(taskId) as { author: string; body: string }[];
  return [`# Task: ${t.title}`, t.description,
    comments.length ? `## Notes\n${comments.map((c) => `- ${c.author}: ${c.body}`).join('\n')}` : '',
    'When finished, reply with a short report: what you did, files changed, open issues.',
    canEscalate ? ESCALATE_HINT : ''].filter(Boolean).join('\n\n');
}

function assessmentPrompt(t: Task, assignee: AgentRow): string {
  return [`You are reviewing a task before assigning it to your ${assignee.role}.`,
    `# Task: ${t.title}`, t.description || '(no description)',
    'Rate its difficulty for that specialist:',
    '- easy: small, well-defined, little reasoning (docs, copy edits, simple config)',
    '- medium: normal feature work, bug fixes, tests',
    '- hard: architecture, ambiguous requirements, cross-cutting or tricky debugging',
    'Reply with ONLY one JSON object, no prose: {"difficulty":"easy|medium|hard","reason":"<one sentence>"}'].join('\n');
}

export function parseAssessment(text: string): { difficulty: Difficulty; reason: string } | null {
  const m = text.match(/\{[^{}]*"difficulty"\s*:\s*"(easy|medium|hard)"[^{}]*\}/i);
  if (!m) return null;
  try { const o = JSON.parse(m[0]); return { difficulty: o.difficulty.toLowerCase(), reason: String(o.reason ?? '') }; }
  catch { return { difficulty: m[1].toLowerCase() as Difficulty, reason: '' }; }
}

export const escalationReason = (text: string | null) => text?.match(/^\s*ESCALATE:\s*(.+)$/im)?.[1]?.trim() ?? null;
const nextDifficulty = (d: Difficulty | null): Difficulty | null => (d === 'easy' ? 'medium' : d === 'medium' ? 'hard' : null);

/**
 * Wires tasks to sessions.
 *  run → (no difficulty & not fixed-model) department leader assesses → work session on the matching model.
 *  Work session asks to ESCALATE or hits max turns → difficulty +1, same conversation resumes on the stronger model.
 *  completed → REVIEW, failed/timeout → FAILED, stopped/interrupted → ASSIGNED.
 */
export class TaskRunner {
  private readonly db: DB;
  private readonly sm: SessionManager;
  private readonly dataDir: string;

  constructor(db: DB, sm: SessionManager, dataDir: string) {
    this.db = db; this.sm = sm; this.dataDir = dataDir;
    sm.on('status', (sessionId: string, status: SessionStatus) => this.onSessionStatus(sessionId, status));
    this.recoverOrphans();
  }

  private agent(id: string) { return this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as unknown as AgentRow; }

  /** Leader of the assignee's department (leaders assess their own work; CEO-level work is assessed by the CEO). */
  assessorFor(assignee: AgentRow): AgentRow {
    if (assignee.department_id) {
      const d = this.db.prepare('SELECT leader_id FROM departments WHERE id = ?').get(assignee.department_id) as { leader_id: string } | undefined;
      if (d?.leader_id) return this.agent(d.leader_id);
    }
    return this.agent('ceo');
  }

  run(taskId: string, actor: string): string {
    const t = getTask(this.db, taskId);
    if (!t) throw new TaskError('task not found');
    if (!t.assignee_id) throw new TaskError('assign an agent first');
    const assignee = this.agent(t.assignee_id);
    if (assignee.status !== 'active') throw new TaskError(`agent ${assignee.id} is ${assignee.status}`);
    claimTask(this.db, taskId, newId('lock'), actor); // throws on unmet deps / duplicate run
    try {
      const sid = !t.difficulty && assignee.model_mode !== 'fixed' ? this.startAssessment(t, assignee, actor) : this.startWork(t.id, actor);
      return sid;
    } catch (e) {
      transition(this.db, taskId, 'ASSIGNED', 'system', `start failed: ${(e as Error).message}`);
      throw e;
    }
  }

  private lock(taskId: string, sessionId: string) {
    this.db.prepare('UPDATE tasks SET lock_session = ? WHERE id = ?').run(sessionId, taskId);
  }

  private startAssessment(t: Task, assignee: AgentRow, actor: string): string {
    const leader = this.assessorFor(assignee);
    const spec: RunSpec = {
      ...buildSpec(leader, assessmentPrompt(t, assignee), projectWorkspace(this.db, this.dataDir, t.project_id), 1),
      model: getPolicy(this.db, 'models.assessment', 'sonnet'),
      tools: [], allowedTools: [], disallowedTools: [], // pure judgement: no tools, ~4k tokens
    };
    const sid = this.sm.enqueue({ agentId: leader.id, taskId: t.id, actor, spec, purpose: 'assess' });
    this.lock(t.id, sid);
    return sid;
  }

  private startWork(taskId: string, actor: string, resume?: { claudeSessionId: string; note: string }): string {
    const t = getTask(this.db, taskId)!;
    const assignee = this.agent(t.assignee_id!);
    const model = modelFor(this.db, t, assignee);
    const canEscalate = assignee.model_mode !== 'fixed' && !!nextDifficulty(t.difficulty) && getPolicy(this.db, 'models.autoEscalate', true);
    const cwd = projectWorkspace(this.db, this.dataDir, t.project_id);
    const maxTurns = getPolicy(this.db, 'runtime.maxTurnsPerSession', 30);
    const base = buildSpec(assignee, taskPrompt(this.db, taskId, canEscalate), cwd, maxTurns);
    const spec: RunSpec = resume
      ? { ...base, model, resumeSessionId: resume.claudeSessionId, prompt: `${resume.note}\n\nContinue the task from where you stopped and finish it.${canEscalate ? `\n\n${ESCALATE_HINT}` : ''}` }
      : { ...base, model };
    const sid = this.sm.enqueue({ agentId: assignee.id, taskId, actor, spec, purpose: 'work' });
    this.lock(taskId, sid);
    return sid;
  }

  private comment(taskId: string, author: string, body: string) {
    this.db.prepare('INSERT INTO task_comments (task_id, author, body) VALUES (?, ?, ?)').run(taskId, author, body);
  }

  private onSessionStatus(sessionId: string, status: SessionStatus) {
    const s = this.sm.get(sessionId);
    if (!s?.task_id) return;
    const t = getTask(this.db, s.task_id);
    if (!t || t.status !== 'RUNNING' || t.lock_session !== sessionId) return;
    if (!['completed', 'failed', 'timeout', 'stopped', 'interrupted'].includes(status)) return;

    if (status === 'stopped' || status === 'interrupted') { transition(this.db, t.id, 'ASSIGNED', 'system', `session ${sessionId} ${status}`); return; }

    if (s.purpose === 'assess') return this.afterAssessment(t, s, status);

    // Work session: escalate on explicit request or on running out of turns.
    const reason = status === 'completed' ? escalationReason(s.result_text)
      : this.resultSubtype(sessionId) === 'error_max_turns' ? 'ran out of turns' : null;
    const assignee = this.agent(t.assignee_id!);
    const up = nextDifficulty(t.difficulty);
    if (reason && up && assignee.model_mode !== 'fixed' && getPolicy(this.db, 'models.autoEscalate', true) && s.claude_session_id) {
      const from = modelFor(this.db, t, assignee);
      this.db.prepare('UPDATE tasks SET difficulty = ? WHERE id = ?').run(up, t.id);
      const to = modelFor(this.db, { difficulty: up }, assignee);
      this.comment(t.id, 'system', `Escalated ${t.difficulty} → ${up} (${from} → ${to}): ${reason}`);
      audit(this.db, 'system', 'task.escalate', t.id, { from: t.difficulty, to: up, reason });
      this.startWork(t.id, 'system', { claudeSessionId: s.claude_session_id, note: `You are now running on a stronger model (${to}) because: ${reason}.` });
      return;
    }

    if (status === 'completed') {
      transition(this.db, t.id, 'REVIEW', 'system', `session ${sessionId} completed`);
      this.db.prepare("UPDATE tasks SET review_status = 'pending' WHERE id = ?").run(t.id);
      if (s.result_text) this.comment(t.id, s.agent_id, s.result_text);
    } else {
      transition(this.db, t.id, 'FAILED', 'system', `session ${sessionId} ${status}`);
    }
  }

  private afterAssessment(t: Task, s: { id: string; agent_id: string; result_text: string | null }, status: SessionStatus) {
    const parsed = status === 'completed' ? parseAssessment(s.result_text ?? '') : null;
    const difficulty: Difficulty = parsed?.difficulty ?? 'medium';
    this.db.prepare('UPDATE tasks SET difficulty = ? WHERE id = ?').run(difficulty, t.id);
    this.comment(t.id, s.agent_id, parsed
      ? `Assessed difficulty: ${difficulty}. ${parsed.reason}`
      : `Assessment ${status === 'completed' ? 'unreadable' : status}; defaulting to medium.`);
    audit(this.db, s.agent_id, 'task.assess', t.id, { difficulty, parsed: !!parsed });
    this.startWork(t.id, 'system');
  }

  private resultSubtype(sessionId: string): string | null {
    const r = this.db.prepare("SELECT json_extract(data, '$.subtype') st FROM session_events WHERE session_id = ? AND kind = 'result' ORDER BY id DESC LIMIT 1").get(sessionId) as { st: string } | undefined;
    return r?.st ?? null;
  }

  /** After a restart, RUNNING tasks whose session is no longer live go back to ASSIGNED. */
  private recoverOrphans() {
    const rows = this.db.prepare(`SELECT t.id FROM tasks t LEFT JOIN sessions s ON s.id = t.lock_session
                                  WHERE t.status = 'RUNNING' AND (s.id IS NULL OR s.status NOT IN ('queued','starting','running'))`).all() as { id: string }[];
    for (const r of rows) transition(this.db, r.id, 'ASSIGNED', 'system', 'recovered after restart');
    if (rows.length) audit(this.db, 'system', 'task.recover', null, { count: rows.length });
  }
}

export { DIFFICULTIES };
