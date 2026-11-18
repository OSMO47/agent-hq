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

/**
 * What the shell actually runs.
 *  - A script that lives in the project folder (`deploy.bat`) is called as `.\deploy.bat`: with
 *    NoDefaultCurrentDirectoryInExePath set (Claude Code sets it; child processes inherit it) cmd.exe will not
 *    look in the current folder otherwise.
 *  - On Windows the console is switched to UTF-8 first, so output is readable on any system code page (e.g. 932).
 */
export function shellCommand(command: string, dir: string, platform = process.platform): string {
  const m = /^\s*("?)([^"\s]+)\1(.*)$/s.exec(command);
  let cmd = command;
  if (m && !/[\\/:]/.test(m[2]) && existsSync(join(dir, m[2]))) cmd = `${platform === 'win32' ? '.\\' : './'}${m[2]}${m[3]}`;
  return platform === 'win32' ? `chcp 65001>nul & ${cmd}` : cmd;
}

/** Child env: as the server's, minus the switch that hides scripts in the working folder. */
export function deployEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of Object.keys(out)) if (k.toLowerCase() === 'nodefaultcurrentdirectoryinexepath') delete out[k];
  return out;
}

/** Where a push would go, read from the project's own git config: current branch, its upstream, else `origin`. */
export interface GitTarget { branch: string; remote: string | null; url: string | null; upstream: string | null; ahead: number | null; files: number }
export function gitTarget(dir: string | null): GitTarget | null {
  if (!dir || !existsSync(dir)) return null;
  const g = (args: string[]) => { const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 10_000 }); return r.status === 0 ? r.stdout.trim() : null; };
  if (g(['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
  const branch = g(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'HEAD';
  const upstream = g(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const remotes = (g(['remote']) ?? '').split(/\s+/).filter(Boolean);
  const remote = upstream ? upstream.split('/')[0] : remotes.includes('origin') ? 'origin' : remotes[0] ?? null;
  const raw = remote ? g(['remote', 'get-url', '--push', remote]) : null;
  const url = raw ? raw.replace(/\/\/[^@/]+@/, '//') : null; // never show credentials embedded in a URL
  const ahead = upstream ? Number(g(['rev-list', '--count', '@{u}..HEAD']) ?? 0) : null;
  const files = (g(['status', '--porcelain']) ?? '').split('\n').filter(Boolean).length;
  return { branch, remote, url, upstream, ahead, files };
}

export interface PublishOptions { commit: boolean; push: boolean; deploy: boolean; command?: string; actor: string }
export interface DeployState { running: boolean; ok: boolean | null; command: string; steps: string[]; output: string; startedAt: string; endedAt: string | null }

/**
 * Runs owner-approved publishing for one project: commit → push → deploy (each optional, in that order,
 * stopping at the first failure). Agents have no route to this. Emits 'change' (projectId).
 */
export class Deployer extends EventEmitter {
  private readonly states = new Map<string, DeployState>();
  private readonly db: DB;
  constructor(db: DB) { super(); this.db = db; }

  state(projectId: string) { return this.states.get(projectId) ?? null; }
  /** Projects with a publish still running or a result the owner has not dismissed yet. */
  active() { return [...this.states.keys()]; }
  dismiss(projectId: string) { if (!this.states.get(projectId)?.running) this.states.delete(projectId); this.emit('change', projectId); }

  /** Owner chose not to publish this batch: clear the Inbox item until new work is DONE. */
  skip(projectId: string, actor: string) {
    this.db.prepare("UPDATE projects SET deploy_decided_at = datetime('now') WHERE id = ?").run(projectId);
    audit(this.db, actor, 'project.deploy.skip', projectId);
    this.emit('change', projectId);
  }

  start(projectId: string, opts: PublishOptions) {
    const p = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
    if (!p) throw new TaskError('project not found');
    if (!p.repo_path || !existsSync(p.repo_path)) throw new TaskError('project has no workspace folder');
    if (this.states.get(projectId)?.running) throw new TaskError('already publishing this project');
    if (!opts.commit && !opts.push && !opts.deploy) throw new TaskError('choose commit, push or deploy');
    const command = String(opts.command ?? '').trim();
    if (opts.deploy && !command) throw new TaskError('deploy command is empty');
    const target = opts.commit || opts.push ? gitTarget(p.repo_path) : null;
    if ((opts.commit || opts.push) && !target) throw new TaskError('the project folder is not a git repository');
    if (opts.push && !target!.remote) throw new TaskError('no git remote to push to: add one with git remote add origin <url>');
    if (opts.deploy) this.db.prepare('UPDATE projects SET deploy_cmd = ? WHERE id = ?').run(command, projectId);

    const steps = [opts.commit && 'commit', opts.push && 'push', opts.deploy && 'deploy'].filter(Boolean) as string[];
    const st: DeployState = { running: true, ok: null, command, steps, output: '', startedAt: new Date().toISOString(), endedAt: null };
    this.states.set(projectId, st);
    const log = (s: string) => { st.output = (st.output + s).slice(-MAX_OUTPUT); this.emit('change', projectId); };
    audit(this.db, opts.actor, 'project.publish', projectId, { steps, command: opts.deploy ? command : undefined, remote: opts.push ? target!.url : undefined, branch: target?.branch });

    const run = (label: string, cmd: string, args: string[] | null) => new Promise<boolean>((resolve) => {
      log(`$ ${label}\n`);
      // args → run git directly (no shell); null → owner-typed command through the shell. stdin closed: nothing can wait for input.
      const child = args
        ? spawn(cmd, args, { cwd: p.repo_path, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...deployEnv(), GIT_TERMINAL_PROMPT: '0' } })
        : spawn(shellCommand(cmd, p.repo_path), { cwd: p.repo_path, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: deployEnv() });
      child.stdout.setEncoding('utf8').on('data', log);
      child.stderr.setEncoding('utf8').on('data', log);
      const timer = setTimeout(() => { log('\n[timeout after 15 min: stopped]\n'); if (child.pid) killTree(child.pid); }, 15 * 60_000);
      let ended = false;
      const done = (code: number | null, err?: Error) => {
        if (ended) return; ended = true; clearTimeout(timer);
        if (err) log(`[failed to start: ${err.message}]\n`);
        log(`[exit ${code ?? 'error'}]\n\n`);
        resolve(code === 0 && !err);
      };
      child.on('error', (e) => done(null, e));
      child.on('close', (code) => done(code));
    });

    (async () => {
      let ok = true;
      if (opts.commit) {
        const titles = (this.db.prepare("SELECT title FROM tasks WHERE project_id = ? AND status = 'DONE' AND updated_at > COALESCE(?, '') ORDER BY updated_at")
          .all(projectId, p.deploy_decided_at) as { title: string }[]).map((t) => `- ${t.title}`);
        if (gitTarget(p.repo_path)!.files === 0) log('(nothing to commit)\n\n');
        else ok = await run('git add -A', 'git', ['add', '-A'])
          && await run('git commit', 'git', ['commit', '-m', `OSMO AGENT: งานที่เสร็จแล้ว\n\n${titles.join('\n') || '- (no task titles)'}`]);
      }
      if (ok && opts.push) {
        const t = gitTarget(p.repo_path)!;
        log(`→ ${t.remote} (${t.url}) · branch ${t.branch}\n`);
        ok = await run(`git push ${t.upstream ? '' : '-u '}${t.remote} ${t.branch}`, 'git', ['push', ...(t.upstream ? [] : ['-u']), t.remote!, t.branch]);
      }
      if (ok && opts.deploy) ok = await run(command, command, null);
      st.running = false; st.ok = ok; st.endedAt = new Date().toISOString();
      if (ok) this.db.prepare("UPDATE projects SET deploy_decided_at = datetime('now') WHERE id = ?").run(projectId);
      log(ok ? '✓ done\n' : '✕ stopped at the failed step\n');
      audit(this.db, 'system', ok ? 'project.publish.ok' : 'project.publish.failed', projectId, { steps });
    })();
    return st;
  }
}
