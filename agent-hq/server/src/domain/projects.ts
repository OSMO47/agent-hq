import { type DB, audit, tx } from '../db.ts';
import { TaskError } from './tasks.ts';

const LIVE = "('queued','starting','running')";

/** What deleting a project would remove from Agent HQ (the workspace folder itself is never touched). */
export function projectFootprint(db: DB, id: string) {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as { id: string; name: string; repo_path: string | null } | undefined;
  if (!p) throw new TaskError('project not found');
  const n = (sql: string) => Number((db.prepare(sql).get(id, id) as { n: number }).n);
  const inProject = 'project_id = ? OR task_id IN (SELECT id FROM tasks WHERE project_id = ?)';
  return {
    project: p,
    tasks: Number((db.prepare('SELECT count(*) n FROM tasks WHERE project_id = ?').get(id) as { n: number }).n),
    sessions: n(`SELECT count(*) n FROM sessions WHERE ${inProject}`),
    liveSessions: n(`SELECT count(*) n FROM sessions WHERE (${inProject}) AND status IN ${LIVE}`),
  };
}

/**
 * Remove a project and everything Agent HQ recorded for it (tasks, their history/comments/deps, sessions + events,
 * messages, project memories). Refuses while any of its sessions is queued or running. Files on disk are not touched.
 */
export function deleteProject(db: DB, id: string, actor: string) {
  const f = projectFootprint(db, id);
  if (f.liveSessions) throw new TaskError(`stop the ${f.liveSessions} running/queued session(s) of this project first`);
  tx(db, () => {
    const tasks = 'SELECT id FROM tasks WHERE project_id = ?';
    const sessions = `SELECT id FROM sessions WHERE project_id = ? OR task_id IN (${tasks})`;
    db.prepare(`DELETE FROM session_events WHERE session_id IN (${sessions})`).run(id, id);
    db.prepare(`DELETE FROM sessions WHERE id IN (${sessions})`).run(id, id);
    db.prepare(`DELETE FROM messages WHERE project_id = ? OR task_id IN (${tasks})`).run(id, id);
    for (const t of ['task_dependencies', 'task_comments', 'task_attachments', 'task_history']) {
      db.prepare(`DELETE FROM ${t} WHERE task_id IN (${tasks})`).run(id);
    }
    db.prepare(`DELETE FROM task_dependencies WHERE depends_on IN (${tasks})`).run(id);
    db.prepare("DELETE FROM memories WHERE scope = 'project' AND scope_id = ?").run(id);
    for (const t of ['meeting_ideas', 'meeting_messages']) db.prepare(`DELETE FROM ${t} WHERE meeting_id IN (SELECT id FROM meetings WHERE project_id = ?)`).run(id);
    db.prepare('DELETE FROM meetings WHERE project_id = ?').run(id);
    db.prepare('UPDATE recruitment_requests SET project_id = NULL WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM tasks WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    audit(db, actor, 'project.delete', id, { name: f.project.name, tasks: f.tasks, sessions: f.sessions });
  });
  return { deleted: id, tasks: f.tasks, sessions: f.sessions };
}
