import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { type DB, audit } from '../db.ts';
import { TaskError } from './tasks.ts';
import { killTree } from '../runtime/claudeCliAdapter.ts';

const OPEN = "('BACKLOG','PLANNED','ASSIGNED','RUNNING','REVIEW','BLOCKED')";
const MAX_OUTPUT = 60_000;

/** Best guess at how this project publishes, from files in its folder. The owner can edit it before deploying. */
export function suggestDeployCommand(dir: string | null): string | null {
  if (!dir) return null;
  if (existsSync(join(dir, 'deploy.bat'))) return 'deploy.bat';
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (pkg.scripts?.deploy) return 'npm run deploy';
  } catch { /* no package.json */ }
  if (existsSync(join(dir, 'firebase.json'))) return 'firebase deploy';
  return null;
}

/**
 * Projects whose work is finished and not yet deployed/skipped: nothing open, and at least one task
 * became DONE after the owner's last deploy decision. These become "deploy?" items in the owner Inbox.
 */
export function finishedProjects(db: DB) {
  const rows = db.prepare(`SELECT p.* FROM projects p
     WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.project_id = p.id AND t.status IN ${OPEN})
       AND EXISTS (SELECT 1 FROM tasks t WHERE t.project_id = p.id AND t.status = 'DONE' AND t.updated_at > COALESCE(p.deploy_decided_at, ''))`).all() as any[];
  return rows.map((p) => ({
    project: p,
    done: db.prepare("SELECT id, title, updated_at FROM tasks WHERE project_id = ? AND status = 'DONE' AND updated_at > COALESCE(?, '') ORDER BY updated_at")
      .all(p.id, p.deploy_decided_at) as { id: string; title: string }[],
    command: p.deploy_cmd ?? suggestDeployCommand(p.repo_path),
  }));
}

export interface DeployState { running: boolean; ok: boolean | null; command: string; output: string; startedAt: string; endedAt: string | null }

/** Runs owner-approved deploys (one at a time per project). Agents have no route to this. Emits 'change' (projectId). */
export class Deployer extends EventEmitter {
  private readonly states = new Map<string, DeployState>();
  private readonly db: DB;
  constructor(db: DB) { super(); this.db = db; }

  state(projectId: string) { return this.states.get(projectId) ?? null; }
  /** Projects with a deploy still running or a result the owner has not dismissed yet. */
  active() { return [...this.states.keys()]; }
  dismiss(projectId: string) { if (!this.states.get(projectId)?.running) this.states.delete(projectId); this.emit('change', projectId); }

  /** Owner chose not to deploy this batch: clear the Inbox item until new work is DONE. */
  skip(projectId: string, actor: string) {
    this.db.prepare("UPDATE projects SET deploy_decided_at = datetime('now') WHERE id = ?").run(projectId);
    audit(this.db, actor, 'project.deploy.skip', projectId);
    this.emit('change', projectId);
  }

  start(projectId: string, opts: { command: string; commit: boolean; actor: string }) {
    const p = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
    if (!p) throw new TaskError('project not found');
    if (!p.repo_path || !existsSync(p.repo_path)) throw new TaskError('project has no workspace folder to deploy');
    if (this.states.get(projectId)?.running) throw new TaskError('a deploy is already running for this project');
    const command = String(opts.command ?? '').trim();
    if (!command) throw new TaskError('deploy command is empty');
    this.db.prepare('UPDATE projects SET deploy_cmd = ? WHERE id = ?').run(command, projectId);

    const st: DeployState = { running: true, ok: null, command, output: '', startedAt: new Date().toISOString(), endedAt: null };
    this.states.set(projectId, st);
    const log = (s: string) => { st.output = (st.output + s).slice(-MAX_OUTPUT); this.emit('change', projectId); };
    audit(this.db, opts.actor, 'project.deploy', projectId, { command, commit: opts.commit });

    if (opts.commit) {
      const titles = (this.db.prepare("SELECT title FROM tasks WHERE project_id = ? AND status = 'DONE' AND updated_at > COALESCE(?, '') ORDER BY updated_at")
        .all(projectId, p.deploy_decided_at) as { title: string }[]).map((t) => `- ${t.title}`);
      const g = (args: string[]) => spawnSync('git', args, { cwd: p.repo_path, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
      if (g(['rev-parse', '--is-inside-work-tree']).status === 0) {
        g(['add', '-A']);
        const c = g(['commit', '-m', `Agent HQ: งานที่เสร็จก่อน deploy\n\n${titles.join('\n') || '- (no task titles)'}`]);
        log(`$ git commit\n${(c.stdout || c.stderr || '').trim() || 'nothing to commit'}\n\n`);
      } else log('(not a git repository: skipped commit)\n\n');
    }

    log(`$ ${command}\n`);
    // Owner-typed command, run in the project folder. stdin closed so scripts that `pause` do not hang.
    const child = spawn(command, { cwd: p.repo_path, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8').on('data', log);
    child.stderr.setEncoding('utf8').on('data', log);
    const timer = setTimeout(() => { log('\n[timeout after 15 min: stopped]\n'); if (child.pid) killTree(child.pid); }, 15 * 60_000);
    let ended = false;
    const finish = (code: number | null, err?: Error) => {
      if (ended) return; ended = true;
      clearTimeout(timer);
      if (err) log(`\n[failed to start: ${err.message}]\n`);
      st.running = false; st.ok = code === 0 && !err; st.endedAt = new Date().toISOString();
      if (st.ok) this.db.prepare("UPDATE projects SET deploy_decided_at = datetime('now') WHERE id = ?").run(projectId);
      log(`\n[exit ${code ?? 'error'}]\n`);
      audit(this.db, 'system', st.ok ? 'project.deploy.ok' : 'project.deploy.failed', projectId, { code });
    };
    child.on('error', (e) => finish(null, e));
    child.on('close', (code) => finish(code));
    return st;
  }
}
