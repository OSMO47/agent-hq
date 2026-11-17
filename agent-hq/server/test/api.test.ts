import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { seed } from '../src/seed.ts';
import { SessionManager } from '../src/runtime/sessionManager.ts';
import { createHq } from '../src/app.ts';
import { ScriptedAdapter, tick } from './helpers.ts';

const port = 4399;
const db = openDb(':memory:');
seed(db);
const ad = new ScriptedAdapter();
const sm = new SessionManager(db, ad);
const { server } = createHq(db, sm, { dataDir: mkdtempSync(join(tmpdir(), 'hq-')), port });
await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
after(() => { server.closeAllConnections(); server.close(); });

const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() as any };
};

test('rejects foreign origins (DNS rebinding / CSRF guard)', async () => {
  const r = await api('GET', '/api/overview', undefined, { origin: 'http://evil.example' });
  assert.equal(r.status, 403);
});

test('overview + org reflect real seeded data', async () => {
  const o = await api('GET', '/api/overview');
  assert.equal(o.body.agents.total, 22);
  assert.equal(o.body.agents.busy, 0);
  const org = await api('GET', '/api/org');
  assert.equal(org.body.departments.length, 6);
});

test('full task flow: create → assign → run → session completes → REVIEW → DONE', async () => {
  const p = (await api('POST', '/api/projects', { name: 'Demo' })).body;
  const t = (await api('POST', '/api/tasks', { projectId: p.id, title: 'Write hello.txt' })).body;
  assert.equal(t.status, 'BACKLOG');
  assert.equal((await api('POST', `/api/tasks/${t.id}/run`)).status, 400, 'cannot run without assignee');

  await api('PATCH', `/api/tasks/${t.id}`, { assigneeId: 'backend-developer' });
  const run = await api('POST', `/api/tasks/${t.id}/run`);
  assert.equal(run.status, 200);
  assert.equal((await api('POST', `/api/tasks/${t.id}/run`)).status, 400, 'duplicate run rejected');

  const r = ad.runs.at(-1)!;
  assert.equal(r.spec.model, 'opus');
  assert.match(r.spec.prompt, /Write hello.txt/);
  r.emit({ kind: 'init', claudeSessionId: 'cc-1', model: 'opus', tools: [] });
  r.emit({ kind: 'result', ok: true, subtype: 'success', text: 'Created hello.txt', claudeSessionId: 'cc-1', numTurns: 2, costUsdEstimate: 0.01, inputTokens: 100, outputTokens: 20, permissionDenials: [] });
  r.exit(0);
  await tick(); await tick();

  const detail = (await api('GET', `/api/tasks/${t.id}`)).body;
  assert.equal(detail.task.status, 'REVIEW');
  assert.equal(detail.comments.at(-1).body, 'Created hello.txt');
  assert.equal((await api('POST', `/api/tasks/${t.id}/transition`, { to: 'DONE' })).body.status, 'DONE');

  // follow-up resumes the same Claude conversation
  const f = await api('POST', `/api/sessions/${run.body.sessionId}/message`, { text: 'Also add a README' });
  assert.equal(f.status, 200);
  assert.equal(ad.runs.at(-1)!.spec.resumeSessionId, 'cc-1');
});

test('stop-all + pause, and only whitelisted policies are editable', async () => {
  assert.equal((await api('POST', '/api/owner/pause', { paused: true })).body.paused, true);
  assert.equal((await api('POST', '/api/owner/stop-all')).status, 200);
  assert.equal((await api('PUT', '/api/policies/org.paused', { value: false })).status, 400);
  assert.equal((await api('PUT', '/api/policies/runtime.maxConcurrentSessions', { value: 3 })).status, 200);
  await api('POST', '/api/owner/pause', { paused: false });
});

test('suspending an agent stops its sessions', async () => {
  const p = (await api('POST', '/api/projects', { name: 'S' })).body;
  const t = (await api('POST', '/api/tasks', { projectId: p.id, title: 'x', assigneeId: 'qa-engineer' })).body;
  await api('POST', `/api/tasks/${t.id}/run`);
  const r = ad.runs.at(-1)!;
  await api('PATCH', '/api/agents/qa-engineer', { status: 'suspended' });
  await tick(); await tick();
  assert.ok(r.stopped);
  assert.equal((await api('GET', `/api/tasks/${t.id}`)).body.task.status, 'ASSIGNED', 'stopped task returns to ASSIGNED');
  assert.equal((await api('POST', `/api/tasks/${t.id}/run`)).status, 400, 'suspended agent cannot run');
});
