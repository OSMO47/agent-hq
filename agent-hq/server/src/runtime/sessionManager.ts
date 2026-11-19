import { EventEmitter } from 'node:events';
import { type DB, newId, audit, getPolicy } from '../db.ts';
import type { RuntimeAdapter, RunHandle, RuntimeEvent, RunSpec } from './types.ts';

export type SessionStatus = 'queued' | 'starting' | 'running' | 'completed' | 'failed' | 'stopped' | 'timeout' | 'interrupted';

export interface SessionRow {
  id: string; agent_id: string; task_id: string | null; purpose: string; claude_session_id: string | null; status: SessionStatus;
  model: string | null; pid: number | null; prompt: string; result_text: string | null; error: string | null;
  cost_usd_estimate: number | null; input_tokens: number | null; output_tokens: number | null; num_turns: number | null;
}

export interface EnqueueInput { agentId: string; taskId?: string; spec: RunSpec; actor: string; purpose?: 'work' | 'assess' | 'plan' | 'dispatch' | 'meeting' | 'message'; projectId?: string }

/**
 * Owns every live Claude process. Enforces the concurrency limit, timeouts, stop / stop-all,
 * and persists every normalized event so sessions survive a dashboard reload.
 * Emits: 'event' (sessionId, RuntimeEvent), 'status' (sessionId, status), 'rateLimit' (info).
 */
export class SessionManager extends EventEmitter {
  private readonly live = new Map<string, { handle: RunHandle; timer: NodeJS.Timeout; stopReason?: SessionStatus }>();
  lastRateLimit: any = null;
  /** When lastRateLimit was reported (ISO). */
  lastRateLimitAt: string | null = null;
  private probing: Promise<unknown> | null = null;
  /** Epoch ms until which no session starts (subscription limit hit). Owner policy: wait, never downgrade the model. */
  rateLimitedUntil = 0;
  private resumeTimer: NodeJS.Timeout | null = null;

  private readonly db: DB;
  private readonly adapter: RuntimeAdapter;

  constructor(db: DB, adapter: RuntimeAdapter) {
    super();
    this.db = db;
    this.adapter = adapter;
    // Crash recovery: processes from a previous server run are gone; queued sessions stay queued.
    const r = db.prepare("UPDATE sessions SET status = 'interrupted', ended_at = datetime('now') WHERE status IN ('starting','running')").run();
    if (r.changes) audit(db, 'system', 'session.recover', null, { interrupted: Number(r.changes) });
    // Last usage report survives restarts (kv), falling back to the newest one recorded in a session.
    const kv = db.prepare("SELECT value, updated_at FROM kv WHERE key = 'claude.rateLimit'").get() as { value: string; updated_at: string } | undefined;
    const ev = db.prepare("SELECT data, created_at FROM session_events WHERE kind = 'rate_limit' ORDER BY id DESC LIMIT 1").get() as { data: string; created_at: string } | undefined;
    if (kv && (!ev || kv.updated_at >= ev.created_at)) { this.lastRateLimit = JSON.parse(kv.value); this.lastRateLimitAt = kv.updated_at; }
    else if (ev) { this.lastRateLimit = JSON.parse(ev.data).info ?? null; this.lastRateLimitAt = ev.created_at; }
  }

  /** Record a usage report from Claude (any session or a probe): memory + kv, limit check, notify. */
  noteRateLimit(info: any) {
    if (!info) return;
    this.lastRateLimit = info;
    this.lastRateLimitAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
    this.db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('claude.rateLimit', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(JSON.stringify(info), this.lastRateLimitAt);
    // Only a real block stops the queue. 'allowed_warning' (e.g. 57% of the weekly window) still runs:
    // treating it as a limit froze every session until the 7-day reset.
    if (info.status && !String(info.status).startsWith('allowed') && info.resetsAt) this.markLimited(info.resetsAt * 1000);
    this.emit('rateLimit', info);
  }

  /**
   * Ask Claude for a fresh usage report without a task: one haiku turn, no tools, no MCP (a few thousand tokens).
   * Claude Code only reports usage inside a run, so this is the only way to read it on demand.
   */
  probeUsage(cwd: string): Promise<unknown> {
    if (this.probing) return this.probing;
    let got: unknown = null;
    const h = this.adapter.start({ prompt: 'Reply with: ok', cwd, model: 'haiku', tools: [], maxTurns: 1 }, (e) => {
      if (e.kind === 'rate_limit') { got = e.info; this.noteRateLimit(e.info); }
    });
    const timer = setTimeout(() => h.stop(), 90_000);
    this.probing = h.done.then(() => { clearTimeout(timer); this.probing = null; return got; });
    return this.probing;
  }

  get runningCount() { return this.live.size; }

  enqueue(input: EnqueueInput): string {
    const id = newId('ses');
    this.db.prepare("INSERT INTO sessions (id, agent_id, task_id, project_id, purpose, status, model, prompt, spec) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)")
      .run(id, input.agentId, input.taskId ?? null, input.projectId ?? (input.taskId ? (this.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(input.taskId) as any)?.project_id ?? null : null), input.purpose ?? 'work', input.spec.model, input.spec.prompt, JSON.stringify(input.spec));
    audit(this.db, input.actor, 'session.enqueue', id, { agentId: input.agentId, taskId: input.taskId });
    this.emit('status', id, 'queued');
    this.pump();
    return id;
  }

  /**
   * Start queued sessions while below the concurrency limit. Pause = "stop working so we can meet":
   * while the org is paused only meeting sessions (read-only) start; normal work waits for resume.
   */
  pump() {
    const paused = !!getPolicy(this.db, 'org.paused', false);
    if (this.rateLimitedUntil > Date.now()) { this.scheduleResume(); return; }
    const max = getPolicy(this.db, 'runtime.maxConcurrentSessions', 2);
    const only = paused ? "AND purpose = 'meeting'" : '';
    while (this.live.size < max) {
      const next = this.db.prepare(`SELECT id, spec FROM sessions WHERE status = 'queued' ${only} ORDER BY queued_at, rowid LIMIT 1`).get() as { id: string; spec: string } | undefined;
      if (!next) return;
      this.launch(next.id, JSON.parse(next.spec) as RunSpec);
    }
  }

  private launch(id: string, spec: RunSpec) {
    this.setStatus(id, 'starting');
    const insEvent = this.db.prepare('INSERT INTO session_events (session_id, kind, data) VALUES (?, ?, ?)');
    const handle = this.adapter.start(spec, (e: RuntimeEvent) => {
      if (e.kind === 'init') {
        this.db.prepare('UPDATE sessions SET claude_session_id = ? WHERE id = ?').run(e.claudeSessionId, id);
        this.setStatus(id, 'running');
      } else if (e.kind === 'rate_limit') {
        this.noteRateLimit(e.info);
      } else if (e.kind === 'result') {
        this.db.prepare(`UPDATE sessions SET result_text = ?, claude_session_id = ?, cost_usd_estimate = ?, input_tokens = ?, output_tokens = ?, num_turns = ? WHERE id = ?`)
          .run(e.text, e.claudeSessionId, e.costUsdEstimate, e.inputTokens, e.outputTokens, e.numTurns, id);
        if (!e.ok && isLimitText(e.text)) this.markLimited(this.lastRateLimit?.resetsAt ? this.lastRateLimit.resetsAt * 1000 : Date.now() + 15 * 60_000);
      }
      if (e.kind !== 'unknown') insEvent.run(id, e.kind, JSON.stringify(e));
      this.emit('event', id, e);
    });
    const timeoutMs = getPolicy(this.db, 'runtime.sessionTimeoutMs', 20 * 60_000);
    const timer = setTimeout(() => this.stop(id, 'system', 'timeout'), timeoutMs);
    timer.unref(); // the child process keeps the server alive, not the watchdog
    this.live.set(id, { handle, timer });
    this.db.prepare("UPDATE sessions SET pid = ?, started_at = datetime('now') WHERE id = ?").run(handle.pid ?? null, id);

    handle.done.then((code) => {
      const entry = this.live.get(id);
      clearTimeout(timer);
      this.live.delete(id);
      const row = this.get(id)!;
      const hasResult = row.result_text !== null;
      const failedResult = this.db.prepare("SELECT 1 FROM session_events WHERE session_id = ? AND kind = 'result' AND json_extract(data, '$.ok') = 0").get(id);
      const status: SessionStatus = entry?.stopReason ?? (code === 0 && hasResult && !failedResult ? 'completed' : 'failed');
      if (status === 'failed' && this.rateLimitedUntil > Date.now()) this.requeueAfterLimit(id, spec);
      else this.finish(id, status, status === 'failed' ? `exit code ${code}` : null);
      this.pump();
    });
  }

  stop(id: string, actor: string, reason: SessionStatus = 'stopped') {
    const entry = this.live.get(id);
    if (entry) { entry.stopReason = reason; entry.handle.stop(); }
    else if (this.get(id)?.status === 'queued') this.finish(id, 'stopped', null);
    audit(this.db, actor, `session.${reason}`, id);
  }

  /** Owner kill switch: cancel the queue and kill every live process tree. */
  stopAll(actor: string): number {
    const queued = this.db.prepare("SELECT id FROM sessions WHERE status = 'queued'").all() as { id: string }[];
    for (const q of queued) this.finish(q.id, 'stopped', 'stop-all');
    const n = this.live.size;
    for (const [id, entry] of this.live) { entry.stopReason = 'stopped'; entry.handle.stop(); this.emit('status', id, 'stopping'); }
    audit(this.db, actor, 'session.stopAll', null, { live: n, queued: queued.length });
    return n + queued.length;
  }

  get(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }

  private markLimited(untilMs: number) {
    if (untilMs <= this.rateLimitedUntil) return;
    this.rateLimitedUntil = untilMs;
    audit(this.db, 'system', 'runtime.rateLimited', null, { until: new Date(untilMs).toISOString() });
    this.emit('limited', untilMs);
  }

  /** Put a limit-killed session back in the queue; resume the same Claude conversation when possible. */
  private requeueAfterLimit(id: string, spec: RunSpec) {
    const row = this.get(id)!;
    const next: RunSpec = row.claude_session_id
      ? { ...spec, resumeSessionId: row.claude_session_id, prompt: 'You were interrupted by a usage limit. Continue the task exactly where you left off.' }
      : spec;
    this.db.prepare("UPDATE sessions SET status = 'queued', spec = ?, result_text = NULL, pid = NULL, started_at = NULL, error = ? WHERE id = ?")
      .run(JSON.stringify(next), `usage limit - resumes after ${new Date(this.rateLimitedUntil).toISOString()}`, id);
    this.emit('status', id, 'queued');
  }

  /** Owner says the usage limit is over: forget the wait and start queued sessions now. */
  clearLimit(actor: string) {
    this.rateLimitedUntil = 0;
    if (this.resumeTimer) { clearTimeout(this.resumeTimer); this.resumeTimer = null; }
    audit(this.db, actor, 'runtime.limitCleared', null);
    this.pump();
  }

  private scheduleResume() {
    if (this.resumeTimer) return;
    this.resumeTimer = setTimeout(() => { this.resumeTimer = null; this.pump(); }, Math.max(1000, this.rateLimitedUntil - Date.now() + 5000));
    this.resumeTimer.unref();
  }

  private setStatus(id: string, s: SessionStatus) {
    this.db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(s, id);
    this.emit('status', id, s);
  }

  private finish(id: string, s: SessionStatus, error: string | null) {
    this.db.prepare("UPDATE sessions SET status = ?, error = COALESCE(?, error), ended_at = datetime('now') WHERE id = ?").run(s, error, id);
    this.emit('status', id, s);
  }
}

export const isLimitText = (t: string) => /usage limit|rate limit|limit reached|resets? at/i.test(t);
