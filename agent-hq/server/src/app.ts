import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import { type DB, newId, audit, getPolicy, setPolicy } from './db.ts';
import { createTask, transition, getTask, addDependency, TaskError, type TaskStatus } from './domain/tasks.ts';
import type { SessionManager } from './runtime/sessionManager.ts';
import { TaskRunner, buildSpec, projectWorkspace, workExtras } from './domain/taskRunner.ts';
import { setAgentSkills } from './domain/skills.ts';
import { avatarVersions, findAvatar, saveAvatar, removeAvatar, MAX_AVATAR_BYTES } from './domain/avatars.ts';
import { readyTasks } from './domain/tasks.ts';
import { CeoPlanner, gitDirty } from './domain/ceoPlanner.ts';
import { deleteProject, projectFootprint } from './domain/projects.ts';
import { Deployer, finishedProjects, gitTarget, suggestDeployCommand } from './domain/deploy.ts';
import { MeetingRoom } from './domain/meetings.ts';

import { isKnownModel } from './runtime/models.ts';
const OWNER = 'owner';
const EDITABLE_POLICIES = new Set(['runtime.maxConcurrentSessions', 'runtime.sessionTimeoutMs', 'runtime.maxTurnsPerSession',
  'runtime.defaultModel', 'models.byDifficulty', 'models.assessment', 'models.autoEscalate', 'recruitment.requiresOwnerApproval', 'recruitment.maxAgents', 'org.autoPilot', 'runtime.permissionMode', 'models.meeting']);
const MODEL_ALIASES = { has: (m: unknown) => isKnownModel(m) };

/** Real CPU utilisation from os.cpus() deltas (os.loadavg() is always 0 on Windows). */
let lastCpu = os.cpus().map((c) => c.times);
let cpuPercent: number | null = null;
setInterval(() => {
  const now = os.cpus().map((c) => c.times);
  let idle = 0, total = 0;
  now.forEach((t, i) => { const p = lastCpu[i]; if (!p) return;
    const d = (k: keyof typeof t) => t[k] - p[k];
    idle += d('idle'); total += d('user') + d('nice') + d('sys') + d('irq') + d('idle'); });
  cpuPercent = total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : null;
  lastCpu = now;
}, 2000).unref();

type Handler = (req: Request, res: Response) => unknown;
const h = (fn: Handler) => async (req: Request, res: Response, next: NextFunction) => {
  try { const out = await fn(req, res); if (!res.headersSent) res.json(out ?? { ok: true }); }
  catch (e) { next(e); }
};

/** Builds the HTTP + WS server. Local-only: rejects foreign Host/Origin headers (DNS-rebinding guard). */
export function createHq(db: DB, sm: SessionManager, opts: { dataDir: string; port: number; staticDir?: string }) {
  const runner = new TaskRunner(db, sm, opts.dataDir);
  const planner = new CeoPlanner(db, sm, opts.dataDir, (projectId) => { broadcast({ type: 'project', projectId }); pilot(); });
  /** Let the organization move on by itself after any change (no-op when autopilot is off or the org is paused). */
  const pilot = () => setImmediate(() => { runner.autoPilot(); broadcast({ type: 'task' }); });
  const deployer = new Deployer(db);
  const meetings = new MeetingRoom(db, sm, opts.dataDir);
  const app = express();
  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!allowedHosts.has(req.headers.host ?? '') || (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, '')) && !/^http:\/\/(localhost|127\.0\.0\.1):5173$/.test(origin))) {
      res.status(403).json({ error: 'forbidden host' }); return;
    }
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  const all = (sql: string, ...p: any[]) => db.prepare(sql).all(...p);
  const one = (sql: string, ...p: any[]) => db.prepare(sql).get(...p);

  // ---------- Overview ----------
  app.get('/api/overview', h(() => {
    const agents = one(`SELECT COUNT(*) total, SUM(status='active') active, SUM(status='suspended') suspended FROM agents`) as any;
    const busy = one(`SELECT COUNT(DISTINCT agent_id) n FROM sessions WHERE status IN ('starting','running')`) as any;
    const failedAgents = one(`SELECT COUNT(DISTINCT agent_id) n FROM sessions WHERE status IN ('failed','timeout') AND ended_at > datetime('now','-1 day')`) as any;
    const tasks = Object.fromEntries((all('SELECT status, COUNT(*) n FROM tasks GROUP BY status') as any[]).map((r) => [r.status, r.n]));
    const sessions = Object.fromEntries((all('SELECT status, COUNT(*) n FROM sessions GROUP BY status') as any[]).map((r) => [r.status, r.n]));
    const cpus = os.cpus();
    return {
      agents: { total: agents.total, active: agents.active, suspended: agents.suspended, busy: busy.n, idle: agents.active - busy.n, failedLast24h: failedAgents.n },
      tasks, sessions,
      pendingApprovals: inbox().length,
      autoPilot: getPolicy(db, 'org.autoPilot', true),
      pendingRecruitment: (one("SELECT COUNT(*) n FROM recruitment_requests WHERE status IN ('pending_ceo','pending_owner')") as any).n,
      system: { cpuCount: cpus.length, cpuPercent, gpu: null, cpuModel: cpus[0]?.model, totalMem: os.totalmem(), freeMem: os.freemem(), uptime: os.uptime() },
      claude: { lastRateLimit: sm.lastRateLimit, lastRateLimitAt: sm.lastRateLimitAt, rateLimitedUntil: sm.rateLimitedUntil || null,
        costEstimateTodayUsd: (one("SELECT SUM(cost_usd_estimate) c FROM sessions WHERE queued_at > datetime('now','start of day')") as any).c },
      paused: getPolicy(db, 'org.paused', false),
      recentActivity: all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 30'),
    };
  }));

  // ---------- Organization ----------
  app.get('/api/org', h(() => {
    let avatars: Record<string, number> | undefined;
    return {
    departments: all('SELECT * FROM departments ORDER BY rowid'),
    agents: (all(`SELECT a.*, (SELECT json_group_array(skill_id) FROM agent_skills WHERE agent_id = a.id) skills, s.id session_id, s.status session_status, s.task_id current_task_id, t.title current_task
                 FROM agents a
                 LEFT JOIN sessions s ON s.id = (SELECT id FROM sessions WHERE agent_id = a.id AND status IN ('queued','starting','running') ORDER BY queued_at DESC LIMIT 1)
                 LEFT JOIN tasks t ON t.id = s.task_id ORDER BY a.level, a.rowid`) as any[])
      .map((a, _i, list) => ({ ...a, skills: JSON.parse(a.skills), avatar: (avatars ??= avatarVersions(opts.dataDir, list))[a.id] ?? null })),
    };
  }));
  // ---------- Agent pictures (owner-supplied, stored only in <data>/avatars) ----------
  const agentOr404 = (id: string) => {
    const a = one('SELECT id, name FROM agents WHERE id = ?', id) as { id: string; name: string } | undefined;
    if (!a) throw new TaskError('agent not found');
    return a;
  };
  app.get('/api/agents/:id/avatar', (req, res) => {
    const a = one('SELECT id, name FROM agents WHERE id = ?', req.params.id) as { id: string; name: string } | undefined;
    const f = a && findAvatar(opts.dataDir, a);
    if (!f) { res.status(404).end(); return; }
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable'); // URL carries ?v=<mtime>
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(f.path);
  });
  app.put('/api/agents/:id/avatar', express.raw({ type: () => true, limit: MAX_AVATAR_BYTES + 1 }), h((req) => {
    const a = agentOr404(req.params.id as string);
    try { saveAvatar(opts.dataDir, a, req.body as Buffer); } catch (e) { throw new TaskError((e as Error).message); }
    audit(db, OWNER, 'agent.avatar', a.id, {});
    broadcast({ type: 'org' });
    return { ok: true };
  }));
  app.delete('/api/agents/:id/avatar', h((req) => {
    const a = agentOr404(req.params.id as string);
    removeAvatar(opts.dataDir, a);
    audit(db, OWNER, 'agent.avatar.remove', a.id, {});
    broadcast({ type: 'org' });
    return { ok: true };
  }));
  app.get('/api/skills', h(() => (all(`SELECT s.id, s.name, s.description, length(s.instructions) size,
      (SELECT json_group_array(agent_id) FROM agent_skills WHERE skill_id = s.id) agents FROM skills s ORDER BY s.name`) as any[])
    .map((r) => ({ ...r, agents: JSON.parse(r.agents) }))));
  app.get('/api/skills/:id', h((req) => {
    const s = one('SELECT * FROM skills WHERE id = ?', req.params.id);
    if (!s) throw new TaskError('skill not found');
    return s;
  }));
  /** Owner sets an agent's skills (replaces the list). */
  app.put('/api/agents/:id/skills', h((req) => {
    if (!one('SELECT 1 FROM agents WHERE id = ?', req.params.id)) throw new TaskError('agent not found');
    const ids = req.body?.skills;
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) throw new TaskError('skills must be a list of ids');
    try { setAgentSkills(db, req.params.id as string, ids, OWNER); } catch (e) { throw new TaskError((e as Error).message); }
    broadcast({ type: 'org' });
    return { skills: ids };
  }));
  app.patch('/api/agents/:id', h((req) => {
    const a = one('SELECT * FROM agents WHERE id = ?', req.params.id) as any;
    if (!a) throw new TaskError('agent not found');
    const { model, status, instructions, permissions, modelMode, name, title, personality } = req.body ?? {};
    // validate everything before writing anything
    if (status && !['active', 'suspended', 'inactive'].includes(status)) throw new TaskError('bad status');
    for (const [k, v] of [['name', name], ['title', title]] as const) {
      if (v != null && (typeof v !== 'string' || !v.trim() || v.trim().length > 40)) throw new TaskError(`${k} must be 1-40 characters`);
    }
    if (personality != null && (typeof personality !== 'string' || personality.trim().length > 500)) throw new TaskError('personality must be at most 500 characters');
    if (modelMode && !['difficulty', 'fixed'].includes(modelMode)) throw new TaskError('bad modelMode');
    if (model && !MODEL_ALIASES.has(model)) throw new TaskError('unknown model');
    if (name != null || title != null) {
      db.prepare('UPDATE agents SET name = COALESCE(?, name), title = COALESCE(?, title) WHERE id = ?').run(name?.trim() ?? null, title?.trim() ?? null, a.id);
    }
    // empty text clears it (no personality line in the prompt); stored as '' so the startup migration does not refill it
    if (personality != null) db.prepare('UPDATE agents SET personality = ? WHERE id = ?').run(personality.trim(), a.id);
    if (modelMode) db.prepare('UPDATE agents SET model_mode = ? WHERE id = ?').run(modelMode, a.id);
    db.prepare('UPDATE agents SET model = COALESCE(?, model), status = COALESCE(?, status), instructions = COALESCE(?, instructions), permissions = COALESCE(?, permissions) WHERE id = ?')
      .run(model ?? null, status ?? null, instructions ?? null, permissions ? JSON.stringify(permissions) : null, a.id);
    audit(db, OWNER, 'agent.update', a.id, req.body);
    if (status === 'suspended') for (const s of all("SELECT id FROM sessions WHERE (agent_id = ? OR task_id IN (SELECT id FROM tasks WHERE assignee_id = ?)) AND status IN ('queued','starting','running')", a.id, a.id) as any[]) sm.stop(s.id, OWNER);
    broadcast({ type: 'org' });
    return one('SELECT * FROM agents WHERE id = ?', a.id);
  }));

  // ---------- Projects & tasks ----------
  app.get('/api/projects', h(() => all('SELECT * FROM projects ORDER BY created_at DESC')));
  app.post('/api/projects', h((req) => {
    const { name, description = '', repoPath = null } = req.body ?? {};
    if (!name) throw new TaskError('name required');
    const id = newId('proj');
    db.prepare('INSERT INTO projects (id, name, description, repo_path) VALUES (?, ?, ?, ?)').run(id, name, description, repoPath);
    audit(db, OWNER, 'project.create', id, { name });
    return one('SELECT * FROM projects WHERE id = ?', id);
  }));
  /** Pause / resume one project: its tasks stop being started, live sessions are stopped (tasks go back to ASSIGNED and resume later). */
  app.post('/api/projects/:id/pause', h((req) => {
    const pid = req.params.id as string;
    if (!one('SELECT 1 FROM projects WHERE id = ?', pid)) throw new TaskError('project not found');
    const paused = req.body?.paused !== false;
    db.prepare('UPDATE projects SET status = ? WHERE id = ?').run(paused ? 'paused' : 'active', pid);
    audit(db, OWNER, paused ? 'project.pause' : 'project.resume', pid);
    let stopped = 0;
    if (paused) for (const r of all("SELECT id FROM sessions WHERE status IN ('queued','starting','running') AND (project_id = ? OR task_id IN (SELECT id FROM tasks WHERE project_id = ?))", pid, pid) as any[]) { sm.stop(r.id, OWNER); stopped++; }
    else pilot();
    broadcast({ type: 'task' });
    return { status: paused ? 'paused' : 'active', stopped };
  }));
  app.get('/api/projects/:id/footprint', h((req) => projectFootprint(db, req.params.id as string)));
  /** Removes the project from OSMO AGENT only; the workspace folder on disk is left untouched. */
  app.delete('/api/projects/:id', h((req) => {
    const out = deleteProject(db, req.params.id as string, OWNER);
    broadcast({ type: 'project' }); broadcast({ type: 'task' });
    return out;
  }));
  /** Everything the board needs about a project besides its tasks: workspace, git safety, CEO activity. */
  app.get('/api/projects/:id/status', h((req) => {
    const id = req.params.id as string;
    const workspace = projectWorkspace(db, opts.dataDir, id);
    return {
      workspace,
      git: gitDirty(workspace),
      planning: one(`SELECT id, status FROM sessions WHERE project_id = ? AND purpose = 'plan' AND status IN ('queued','starting','running') ORDER BY queued_at DESC LIMIT 1`, id) ?? null,
      messages: all("SELECT * FROM messages WHERE project_id = ? ORDER BY id DESC LIMIT 20", id),
      ready: readyTasks(db, id).length,
      paused: getPolicy(db, 'org.paused', false),
    };
  }));
  app.post('/api/projects/:id/brief', h((req) => ({ sessionId: planner.brief(req.params.id as string, String(req.body?.text ?? ''), OWNER) })));
  /** Start every ASSIGNED task whose dependencies are done (concurrency limit still applies via the queue). */
  app.post('/api/projects/:id/run-ready', h((req) => {
    const started: string[] = []; const errors: string[] = [];
    for (const t of readyTasks(db, req.params.id as string)) {
      try { runner.run(t.id, OWNER); started.push(t.id); } catch (e) { errors.push(`${t.title}: ${(e as Error).message}`); }
    }
    broadcast({ type: 'task' });
    return { started: started.length, errors };
  }));

  app.get('/api/tasks', h((req) => {
    const pid = req.query.projectId as string | undefined;
    return {
      tasks: pid ? all('SELECT * FROM tasks WHERE project_id = ? ORDER BY priority, created_at', pid) : all('SELECT * FROM tasks ORDER BY priority, created_at'),
      dependencies: all('SELECT * FROM task_dependencies'),
    };
  }));
  app.get('/api/tasks/:id', h((req) => {
    const t = getTask(db, req.params.id as string);
    if (!t) throw new TaskError('task not found');
    return { task: t,
      dependsOn: all('SELECT t.id, t.title, t.status FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on WHERE d.task_id = ?', t.id),
      history: all('SELECT * FROM task_history WHERE task_id = ? ORDER BY id', t.id),
      comments: all('SELECT * FROM task_comments WHERE task_id = ? ORDER BY id', t.id),
      sessions: all('SELECT id, status, agent_id, queued_at, ended_at, error FROM sessions WHERE task_id = ? ORDER BY queued_at DESC', t.id) };
  }));
  app.post('/api/tasks', h((req) => {
    const b = req.body ?? {};
    if (!b.projectId || !b.title) throw new TaskError('projectId and title required');
    const t = createTask(db, { ...b, actor: OWNER });
    broadcast({ type: 'task', task: t });
    pilot();
    return t;
  }));
  app.patch('/api/tasks/:id', h((req) => {
    const id = req.params.id as string;
    const { assigneeId, priority, title, description, dependsOn, difficulty } = req.body ?? {};
    const t = getTask(db, id);
    if (!t) throw new TaskError('task not found');
    if (t.status === 'RUNNING' && assigneeId !== undefined) throw new TaskError('cannot reassign a running task');
    db.prepare('UPDATE tasks SET assignee_id = COALESCE(?, assignee_id), priority = COALESCE(?, priority), title = COALESCE(?, title), description = COALESCE(?, description), updated_at = datetime(\'now\') WHERE id = ?')
      .run(assigneeId ?? null, priority ?? null, title ?? null, description ?? null, id);
    if (difficulty !== undefined) {
      if (t.status === 'RUNNING') throw new TaskError('cannot change difficulty while running');
      db.prepare('UPDATE tasks SET difficulty = ? WHERE id = ?').run(difficulty || null, id);
    }
    for (const d of dependsOn ?? []) addDependency(db, id, d);
    if (assigneeId && ['BACKLOG', 'PLANNED'].includes(t.status)) transition(db, id, 'ASSIGNED', OWNER, `assigned to ${assigneeId}`);
    audit(db, OWNER, 'task.update', id, req.body);
    const out = getTask(db, id);
    broadcast({ type: 'task', task: out });
    pilot();
    return out;
  }));
  app.post('/api/tasks/:id/transition', h((req) => {
    const t = transition(db, req.params.id as string, req.body?.to as TaskStatus, OWNER, req.body?.note ?? '');
    if (t.status === 'DONE') db.prepare("UPDATE tasks SET review_status = 'approved' WHERE id = ?").run(t.id);
    if (req.body?.to === 'ASSIGNED' && req.body?.note) db.prepare('INSERT INTO task_comments (task_id, author, body) VALUES (?, ?, ?)').run(t.id, OWNER, req.body.note);
    broadcast({ type: 'task', task: getTask(db, t.id) });
    pilot();
    return getTask(db, t.id);
  }));
  app.post('/api/tasks/:id/comments', h((req) => {
    if (!req.body?.body) throw new TaskError('body required');
    db.prepare('INSERT INTO task_comments (task_id, author, body) VALUES (?, ?, ?)').run(req.params.id, OWNER, req.body.body);
    return { ok: true };
  }));
  app.post('/api/tasks/:id/run', h((req) => {
    const sessionId = runner.run(req.params.id as string, OWNER);
    broadcast({ type: 'task', task: getTask(db, req.params.id as string) });
    return { sessionId };
  }));

  // ---------- Sessions ----------
  app.get('/api/sessions', h(() => all(`SELECT s.id, s.agent_id, a.name agent_name, a.role, s.task_id, s.purpose, t.title task_title, s.status, s.model,
      s.claude_session_id, s.error, s.cost_usd_estimate, s.input_tokens, s.output_tokens, s.num_turns, s.queued_at, s.started_at, s.ended_at
      FROM sessions s JOIN agents a ON a.id = s.agent_id LEFT JOIN tasks t ON t.id = s.task_id ORDER BY s.queued_at DESC LIMIT 200`)));
  app.get('/api/sessions/:id', h((req) => {
    const s = sm.get(req.params.id as string);
    if (!s) throw new TaskError('session not found');
    return { session: s, events: all('SELECT id, kind, data, created_at FROM session_events WHERE session_id = ? ORDER BY id', s.id).map((e: any) => ({ ...e, data: JSON.parse(e.data) })) };
  }));
  app.post('/api/sessions/:id/stop', h((req) => { sm.stop(req.params.id as string, OWNER); return { ok: true }; }));
  /** Follow-up instruction: new session resuming the same Claude conversation. */
  app.post('/api/sessions/:id/message', h((req) => {
    const s = sm.get(req.params.id as string);
    if (!s?.claude_session_id) throw new TaskError('session has no Claude conversation to resume yet');
    if (['queued', 'starting', 'running'].includes(s.status)) throw new TaskError('session is still running');
    const agent = one('SELECT * FROM agents WHERE id = ?', s.agent_id) as any;
    const prev = JSON.parse((one('SELECT spec FROM sessions WHERE id = ?', s.id) as any).spec);
    const spec = { ...buildSpec(agent, String(req.body?.text ?? ''), prev.cwd, getPolicy(db, 'runtime.maxTurnsPerSession', 30), getPolicy(db, 'runtime.permissionMode', 'auto'), workExtras(db, agent.id)), resumeSessionId: s.claude_session_id };
    if (!spec.prompt) throw new TaskError('text required');
    return { sessionId: sm.enqueue({ agentId: agent.id, actor: OWNER, spec, purpose: 'message' }) };
  }));

  // ---------- Owner command center ----------
  /** Fresh Claude usage on demand (one tiny haiku turn). */
  app.post('/api/owner/check-usage', h(async () => ({ info: await sm.probeUsage(opts.dataDir) })));
  app.post('/api/owner/stop-all', h(() => ({ stopped: sm.stopAll(OWNER) })));
  app.post('/api/owner/clear-limit', h(() => { sm.clearLimit(OWNER); return { ok: true }; }));
  app.post('/api/owner/pause', h((req) => {
    const paused = !!req.body?.paused;
    setPolicy(db, 'org.paused', paused, OWNER);
    if (!paused) { sm.pump(); pilot(); }
    broadcast({ type: 'paused', paused });
    return { paused };
  }));
  app.get('/api/policies', h(() => all('SELECT * FROM policies ORDER BY key').map((p: any) => ({ ...p, value: JSON.parse(p.value) }))));
  app.put('/api/policies/:key', h((req) => {
    const key = req.params.key as string;
    if (!EDITABLE_POLICIES.has(key)) throw new TaskError(`policy ${key} is not editable here`);
    const v = req.body?.value;
    if (key === 'models.byDifficulty' && !(v && ['easy', 'medium', 'hard'].every((d) => MODEL_ALIASES.has(v[d])))) throw new TaskError('need a model (opus|sonnet|haiku) for easy, medium and hard');
    if (key === 'runtime.permissionMode' && !['auto', 'default', 'acceptEdits'].includes(v)) throw new TaskError('permissionMode must be auto, default or acceptEdits');
    if ((key === 'runtime.defaultModel' || key === 'models.assessment' || key === 'models.meeting') && !MODEL_ALIASES.has(v)) throw new TaskError('unknown model');
    if (key === 'models.autoEscalate' && typeof v !== 'boolean') throw new TaskError('must be true or false');
    if (/maxConcurrentSessions|maxTurnsPerSession|maxAgents|sessionTimeoutMs/.test(key) && !(Number.isInteger(v) && v > 0)) throw new TaskError('must be a positive integer');
    setPolicy(db, key, req.body?.value, OWNER);
    sm.pump();
    return { key, value: req.body?.value };
  }));
  /** Owner inbox: only what needs a human. Decisions agents flagged, failed tasks, tasks nobody could be assigned to. */
  function inbox() {
    const last = (taskId: string, author?: string) => (one(`SELECT body FROM task_comments WHERE task_id = ? ${author ? 'AND author = ?' : "AND author NOT IN ('owner','system')"} ORDER BY id DESC LIMIT 1`, ...(author ? [taskId, author] : [taskId])) as any)?.body ?? null;
    const items: any[] = [];
    for (const t of all("SELECT * FROM tasks WHERE status = 'REVIEW' AND COALESCE(review_status,'pending') = 'pending' ORDER BY updated_at DESC") as any[]) {
      items.push({ kind: 'decision', task: t, question: last(t.id, 'system')?.replace(/^Needs your decision:\s*/, '') ?? null, report: last(t.id) });
    }
    for (const t of all("SELECT * FROM tasks WHERE status = 'FAILED' ORDER BY updated_at DESC") as any[]) items.push({ kind: 'failed', task: t, report: last(t.id) });
    for (const t of all(`SELECT * FROM tasks t WHERE t.assignee_id IS NULL AND t.status IN ('BACKLOG','PLANNED')
        AND (? = 0 OR ((SELECT COUNT(*) FROM sessions s WHERE s.task_id = t.id AND s.purpose = 'dispatch') >= 2
             AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.task_id = t.id AND s.purpose = 'dispatch' AND s.status IN ('queued','starting','running'))))`,
        getPolicy(db, 'org.autoPilot', true) ? 1 : 0) as any[]) items.push({ kind: 'unassigned', task: t });
    // Meetings whose attendee list the CEO proposed and the owner has not confirmed yet.
    for (const l of all("SELECT * FROM meeting_plans WHERE status = 'proposed' ORDER BY created_at DESC") as any[]) {
      items.push({ kind: 'meeting', task: { id: l.id, title: l.topic, updated_at: l.created_at }, meeting: { id: l.id, topic: l.topic, pending: 0, plan: true } });
    }
    // Meetings that produced ideas the owner has not decided on yet.
    for (const m of all("SELECT m.*, (SELECT COUNT(*) FROM meeting_ideas i WHERE i.meeting_id = m.id AND i.status = 'pending') pending FROM meetings m WHERE m.status = 'done' ORDER BY m.ended_at DESC") as any[]) {
      if (m.pending > 0) items.push({ kind: 'meeting', task: { id: m.id, title: m.topic, updated_at: m.ended_at }, meeting: m });
    }
    // Finished work: tell the owner and ask whether to deploy (agents never deploy).
    const finished = finishedProjects(db);
    // Keep showing a project whose deploy is running or whose result is not dismissed yet.
    for (const id of deployer.active()) {
      if (finished.some((f) => f.project.id === id)) continue;
      const p = one('SELECT * FROM projects WHERE id = ?', id) as any;
      if (p) finished.push({ project: p, done: [], command: p.deploy_cmd });
    }
    for (const f of finished) {
      items.unshift({ kind: 'finished', task: { id: f.project.id, title: f.project.name, updated_at: f.done.at(-1)?.updated_at }, project: f.project,
        done: f.done, command: f.command, git: gitTarget(f.project.repo_path), deploy: deployer.state(f.project.id) });
    }
    return items;
  }
  app.get('/api/inbox', h(() => inbox()));

  // ---------- Idea meetings ----------
  app.get('/api/meetings', h(() => {
    const ms = all(`SELECT m.*, p.name project_name,
      (SELECT COUNT(*) FROM meeting_messages x WHERE x.meeting_id = m.id) said,
      (SELECT COUNT(*) FROM meeting_ideas i WHERE i.meeting_id = m.id AND i.status = 'pending') pending
      FROM meetings m JOIN projects p ON p.id = m.project_id ORDER BY m.created_at DESC LIMIT 100`) as any[];
    // Plans still waiting on the CEO / the owner appear in the same list (status 'selecting' | 'proposed' | 'failed').
    const plans = all(`SELECT l.id, l.topic, l.status, l.created_at, l.rounds, p.name project_name, 0 pending, 0 said
      FROM meeting_plans l JOIN projects p ON p.id = l.project_id WHERE l.status IN ('selecting','proposed','failed')`) as any[];
    return [...plans, ...ms].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }));
  app.get('/api/meetings/:id', h((req) => {
    if (String(req.params.id).startsWith('plan_')) {
      const plan = one('SELECT l.*, p.name project_name FROM meeting_plans l JOIN projects p ON p.id = l.project_id WHERE l.id = ?', req.params.id) as any;
      if (!plan) throw new TaskError('meeting plan not found');
      return { plan, suggested: JSON.parse(plan.suggested) };
    }
    const m = one('SELECT m.*, p.name project_name FROM meetings m JOIN projects p ON p.id = m.project_id WHERE m.id = ?', req.params.id) as any;
    if (!m) throw new TaskError('meeting not found');
    const cur = m.current_session ? one('SELECT s.id, s.status, s.agent_id, a.name, a.role FROM sessions s JOIN agents a ON a.id = s.agent_id WHERE s.id = ?', m.current_session) : null;
    return { meeting: m, current: cur,
      messages: all('SELECT x.*, a.name, a.role FROM meeting_messages x JOIN agents a ON a.id = x.agent_id WHERE x.meeting_id = ? ORDER BY x.id', m.id),
      ideas: all('SELECT * FROM meeting_ideas WHERE meeting_id = ? ORDER BY rowid', m.id) };
  }));
  /** With `participants` the meeting starts right away; without them the CEO proposes attendees first (a plan the owner approves). */
  app.post('/api/meetings', h((req) => Array.isArray(req.body?.participants) && req.body.participants.length
    ? meetings.start({ projectId: String(req.body?.projectId ?? ''), topic: String(req.body?.topic ?? ''), participants: req.body.participants, rounds: req.body?.rounds, actor: OWNER })
    : meetings.propose({ projectId: String(req.body?.projectId ?? ''), topic: String(req.body?.topic ?? ''), rounds: req.body?.rounds, actor: OWNER })));
  app.post('/api/meeting-plans/:id/approve', h((req) => meetings.approvePlan(req.params.id as string,
    Array.isArray(req.body?.participants) ? req.body.participants : undefined, req.body?.rounds ? Number(req.body.rounds) : undefined, OWNER)));
  app.post('/api/meeting-plans/:id/cancel', h((req) => { meetings.cancelPlan(req.params.id as string, OWNER); return { ok: true }; }));
  app.post('/api/meetings/:id/stop', h((req) => { meetings.stop(req.params.id as string, OWNER); return { ok: true }; }));
  app.post('/api/ideas/:id/:decision', h((req) => {
    const d = req.params.decision;
    if (d !== 'approve' && d !== 'reject') throw new TaskError('approve or reject');
    meetings.decide(req.params.id as string, d === 'approve', OWNER);
    if (d === 'approve') pilot();
    return { ok: true };
  }));
  /** Owner-only publish: runs the project's deploy command (optionally committing first). */
  app.post('/api/projects/:id/deploy', h((req) => deployer.start(req.params.id as string, { command: String(req.body?.command ?? ''), commit: !!req.body?.commit, push: !!req.body?.push, deploy: req.body?.deploy !== false && !!req.body?.command, actor: OWNER })));
  /** Same data as the Inbox "finished" card, available anytime (manual publish from the Task board). */
  app.get('/api/projects/:id/publish', h((req) => {
    const p = one('SELECT * FROM projects WHERE id = ?', req.params.id) as any;
    if (!p) throw new TaskError('project not found');
    const f = finishedProjects(db).find((x) => x.project.id === p.id);
    return { kind: 'finished', task: { id: p.id, title: p.name, updated_at: null }, project: p, done: f?.done ?? [],
      command: p.deploy_cmd ?? suggestDeployCommand(p.repo_path), git: gitTarget(p.repo_path), deploy: deployer.state(p.id) };
  }));
  app.get('/api/projects/:id/deploy', h((req) => deployer.state(req.params.id as string)));
  app.post('/api/projects/:id/deploy/dismiss', h((req) => { deployer.dismiss(req.params.id as string); return { ok: true }; }));
  app.post('/api/projects/:id/deploy/skip', h((req) => { deployer.skip(req.params.id as string, OWNER); return { ok: true }; }));

  app.get('/api/audit', h(() => all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 500')));

  if (opts.staticDir) {
    app.use(express.static(opts.staticDir));
    app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile('index.html', { root: opts.staticDir }));
  }

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const userError = err instanceof TaskError || /constraint|FOREIGN KEY/i.test(err.message);
    res.status(userError ? 400 : 500).json({ error: err.message });
  });

  // ---------- WebSocket: live push ----------
  const server: Server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws',
    verifyClient: ({ req }: { req: import('node:http').IncomingMessage }) => allowedHosts.has(req.headers.host ?? '') });
  function broadcast(msg: object) {
    const data = JSON.stringify(msg);
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
  }
  sm.on('event', (sessionId: string, event: unknown) => broadcast({ type: 'session.event', sessionId, event }));
  sm.on('status', (sessionId: string, status: string) => broadcast({ type: 'session.status', sessionId, status }));
  sm.on('rateLimit', () => broadcast({ type: 'usage' }));
  meetings.on('change', (meetingId: string) => broadcast({ type: 'meeting', meetingId }));
  let deployTick: NodeJS.Timeout | null = null; // output can be chatty: coalesce pushes
  deployer.on('change', (projectId: string) => { if (!deployTick) deployTick = setTimeout(() => { deployTick = null; broadcast({ type: 'deploy', projectId }); }, 400); });
  sm.on('limited', (until: number) => broadcast({ type: 'limited', until }));

  pilot(); // pick up anything left waiting from before a restart
  return { app, server, wss, broadcast, runner };
}
