import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type DB, newId, audit, getPolicy } from '../db.ts';
import { claimTask, transition, getTask, TaskError, type Task } from './tasks.ts';
import type { SessionManager, SessionStatus } from '../runtime/sessionManager.ts';
import type { RunSpec } from '../runtime/types.ts';

interface AgentRow { id: string; name: string; role: string; model: string; instructions: string; permissions: string; status: string; workspace: string | null }

/** Workspace for a project: its repo if configured, else ./data/workspaces/<projectId>. Agents get nothing outside it. */
export function projectWorkspace(db: DB, dataDir: string, projectId: string): string {
  const p = db.prepare('SELECT repo_path FROM projects WHERE id = ?').get(projectId) as { repo_path: string | null } | undefined;
  if (!p) throw new TaskError(`project ${projectId} not found`);
  const dir = p.repo_path ? resolve(p.repo_path) : join(dataDir, 'workspaces', projectId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const DEFAULT_DIFFICULTY_MODELS = { easy: 'haiku', medium: 'sonnet', hard: 'opus' };

/** Task difficulty picks the model (owner policy); no difficulty → the agent's own model. */
export function modelFor(db: DB, task: Pick<Task, 'difficulty'>, agentModel: string): string {
  if (!task.difficulty) return agentModel;
  const map = getPolicy<Record<string, string>>(db, 'models.byDifficulty', DEFAULT_DIFFICULTY_MODELS);
  return map[task.difficulty] ?? agentModel;
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

function taskPrompt(db: DB, taskId: string): string {
  const t = getTask(db, taskId)!;
  const comments = db.prepare('SELECT author, body FROM task_comments WHERE task_id = ? ORDER BY id').all(taskId) as { author: string; body: string }[];
  return [`# Task: ${t.title}`, t.description,
    comments.length ? `## Notes\n${comments.map((c) => `- ${c.author}: ${c.body}`).join('\n')}` : '',
    'When finished, reply with a short report: what you did, files changed, open issues.'].filter(Boolean).join('\n\n');
}

/**
 * Wires tasks to sessions: run = claim lock + enqueue; session end moves the task
 * (completed → REVIEW, failed/timeout → FAILED, stopped/interrupted → ASSIGNED for retry).
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

  run(taskId: string, actor: string): string {
    const t = getTask(this.db, taskId);
    if (!t) throw new TaskError('task not found');
    if (!t.assignee_id) throw new TaskError('assign an agent first');
    const agent = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(t.assignee_id) as unknown as AgentRow;
    if (agent.status !== 'active') throw new TaskError(`agent ${agent.id} is ${agent.status}`);
    const sessionLock = newId('lock');
    claimTask(this.db, taskId, sessionLock, actor); // throws on unmet deps / duplicate run
    try {
      const cwd = projectWorkspace(this.db, this.dataDir, t.project_id);
      const maxTurns = getPolicy(this.db, 'runtime.maxTurnsPerSession', 30);
      const spec = { ...buildSpec(agent, taskPrompt(this.db, taskId), cwd, maxTurns), model: modelFor(this.db, t, agent.model) };
      const sid = this.sm.enqueue({ agentId: agent.id, taskId, actor, spec });
      this.db.prepare('UPDATE tasks SET lock_session = ? WHERE id = ?').run(sid, taskId);
      return sid;
    } catch (e) {
      transition(this.db, taskId, 'ASSIGNED', 'system', `start failed: ${(e as Error).message}`);
      throw e;
    }
  }

  private onSessionStatus(sessionId: string, status: SessionStatus) {
    const s = this.sm.get(sessionId);
    if (!s?.task_id) return;
    const t = getTask(this.db, s.task_id);
    if (!t || t.status !== 'RUNNING' || t.lock_session !== sessionId) return;
    const to = status === 'completed' ? 'REVIEW' : status === 'failed' || status === 'timeout' ? 'FAILED'
      : status === 'stopped' || status === 'interrupted' ? 'ASSIGNED' : null;
    if (!to) return;
    transition(this.db, t.id, to, 'system', `session ${sessionId} ${status}`);
    if (to === 'REVIEW') {
      this.db.prepare("UPDATE tasks SET review_status = 'pending' WHERE id = ?").run(t.id);
      if (s.result_text) this.db.prepare('INSERT INTO task_comments (task_id, author, body) VALUES (?, ?, ?)').run(t.id, s.agent_id, s.result_text);
    }
  }

  /** After a restart, RUNNING tasks whose session is no longer live go back to ASSIGNED. */
  private recoverOrphans() {
    const rows = this.db.prepare(`SELECT t.id FROM tasks t LEFT JOIN sessions s ON s.id = t.lock_session
                                  WHERE t.status = 'RUNNING' AND (s.id IS NULL OR s.status NOT IN ('queued','starting','running'))`).all() as { id: string }[];
    for (const r of rows) transition(this.db, r.id, 'ASSIGNED', 'system', 'recovered after restart');
    if (rows.length) audit(this.db, 'system', 'task.recover', null, { count: rows.length });
  }
}
