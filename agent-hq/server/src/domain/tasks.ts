import { type DB, tx, newId, audit } from '../db.ts';

export type TaskStatus =
  | 'BACKLOG' | 'PLANNED' | 'ASSIGNED' | 'RUNNING' | 'REVIEW' | 'DONE' | 'BLOCKED' | 'FAILED' | 'CANCELLED';

export type Difficulty = 'easy' | 'medium' | 'hard';
export const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

export interface Task {
  id: string; project_id: string; parent_id: string | null; title: string; description: string;
  status: TaskStatus; priority: number; difficulty: Difficulty | null; deadline: string | null; assignee_id: string | null;
  department_id: string | null; review_status: string | null; attempts: number; lock_session: string | null; continuations?: number;
}

/** Allowed lifecycle transitions. RUNNING is entered only through claimTask(). */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  BACKLOG: ['PLANNED', 'ASSIGNED', 'CANCELLED', 'BLOCKED'],
  PLANNED: ['ASSIGNED', 'BACKLOG', 'CANCELLED', 'BLOCKED'],
  ASSIGNED: ['PLANNED', 'CANCELLED', 'BLOCKED'],
  RUNNING: ['REVIEW', 'FAILED', 'ASSIGNED', 'CANCELLED'],
  REVIEW: ['DONE', 'ASSIGNED', 'FAILED'],
  BLOCKED: ['BACKLOG', 'PLANNED', 'ASSIGNED', 'CANCELLED'],
  FAILED: ['ASSIGNED', 'CANCELLED'],
  DONE: [],
  CANCELLED: [],
};

export class TaskError extends Error {}

export function createTask(db: DB, input: {
  projectId: string; title: string; description?: string; parentId?: string; priority?: number; difficulty?: Difficulty;
  assigneeId?: string; departmentId?: string; deadline?: string; dependsOn?: string[]; actor?: string;
}): Task {
  const id = newId('task');
  const actor = input.actor ?? 'owner';
  tx(db, () => {
    db.prepare(`INSERT INTO tasks (id, project_id, parent_id, title, description, priority, difficulty, assignee_id, department_id, deadline, status, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.projectId, input.parentId ?? null, input.title, input.description ?? '', input.priority ?? 2, input.difficulty ?? null,
        input.assigneeId ?? null, input.departmentId ?? null, input.deadline ?? null,
        input.assigneeId ? 'ASSIGNED' : 'BACKLOG', actor);
    for (const dep of input.dependsOn ?? []) addDependency(db, id, dep);
    db.prepare('INSERT INTO task_history (task_id, from_status, to_status, actor) VALUES (?, NULL, ?, ?)')
      .run(id, input.assigneeId ? 'ASSIGNED' : 'BACKLOG', actor);
  });
  return getTask(db, id)!;
}

export function getTask(db: DB, id: string): Task | undefined {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
}

/** Add dependency, rejecting cycles. */
export function addDependency(db: DB, taskId: string, dependsOn: string) {
  // Cycle check: does `dependsOn` (transitively) depend on `taskId`?
  const reach = db.prepare(`WITH RECURSIVE r(id) AS (SELECT ? UNION SELECT d.depends_on FROM task_dependencies d JOIN r ON d.task_id = r.id)
                            SELECT 1 FROM r WHERE id = ?`).get(dependsOn, taskId);
  if (reach) throw new TaskError(`dependency ${taskId} -> ${dependsOn} would create a cycle`);
  db.prepare('INSERT OR IGNORE INTO task_dependencies (task_id, depends_on) VALUES (?, ?)').run(taskId, dependsOn);
}

export function unmetDependencies(db: DB, taskId: string): string[] {
  return (db.prepare(`SELECT t.id FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on
                      WHERE d.task_id = ? AND t.status <> 'DONE'`).all(taskId) as { id: string }[]).map((r) => r.id);
}

export function transition(db: DB, taskId: string, to: TaskStatus, actor: string, note = ''): Task {
  return tx(db, () => {
    const t = getTask(db, taskId);
    if (!t) throw new TaskError(`task ${taskId} not found`);
    if (to === 'RUNNING') throw new TaskError('use claimTask() to start a task');
    if (!TRANSITIONS[t.status].includes(to)) throw new TaskError(`illegal transition ${t.status} -> ${to}`);
    // Any transition out of RUNNING releases the execution lock.
    db.prepare("UPDATE tasks SET status = ?, lock_session = NULL, updated_at = datetime('now') WHERE id = ?").run(to, taskId);
    db.prepare('INSERT INTO task_history (task_id, from_status, to_status, actor, note) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, t.status, to, actor, note);
    audit(db, actor, 'task.transition', taskId, { from: t.status, to, note });
    return getTask(db, taskId)!;
  });
}

/**
 * Atomically move ASSIGNED -> RUNNING and lock the task to one session.
 * Throws if dependencies are unmet, the task has no assignee, or it is already locked (duplicate execution).
 */
export function claimTask(db: DB, taskId: string, sessionId: string, actor: string): Task {
  return tx(db, () => {
    const t = getTask(db, taskId);
    if (!t) throw new TaskError(`task ${taskId} not found`);
    if (!t.assignee_id) throw new TaskError('task has no assignee');
    const unmet = unmetDependencies(db, taskId);
    if (unmet.length) throw new TaskError(`unmet dependencies: ${unmet.join(', ')}`);
    const r = db.prepare(`UPDATE tasks SET status = 'RUNNING', lock_session = ?, attempts = attempts + 1, updated_at = datetime('now')
                          WHERE id = ? AND status = 'ASSIGNED' AND lock_session IS NULL`).run(sessionId, taskId);
    if (r.changes !== 1) throw new TaskError(`task not claimable (status ${t.status}, lock ${t.lock_session ?? 'none'})`);
    db.prepare("INSERT INTO task_history (task_id, from_status, to_status, actor, note) VALUES (?, 'ASSIGNED', 'RUNNING', ?, ?)")
      .run(taskId, actor, `session ${sessionId}`);
    return getTask(db, taskId)!;
  });
}

/** Tasks that are ASSIGNED, unlocked, and whose dependencies are all DONE — ordered by priority. */
export function readyTasks(db: DB, projectId?: string): Task[] {
  return db.prepare(`SELECT t.* FROM tasks t
     WHERE t.status = 'ASSIGNED' AND t.lock_session IS NULL ${projectId ? 'AND t.project_id = ?' : ''}
       AND NOT EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks x ON x.id = d.depends_on
                       WHERE d.task_id = t.id AND x.status <> 'DONE')
     ORDER BY t.priority, t.created_at`).all(...(projectId ? [projectId] : [])) as unknown as Task[];
}
