import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, setPolicy } from '../src/db.ts';
import { seed } from '../src/seed.ts';
import { SessionManager } from '../src/runtime/sessionManager.ts';
import { createHq } from '../src/app.ts';
import { ScriptedAdapter, tick } from './helpers.ts';

const port = 4399;
const db = openDb(':memory:');
seed(db);
setPolicy(db, 'org.autoPilot', false, 'test'); // these tests drive the manual flow; autopilot has its own tests
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
  const t = (await api('POST', '/api/tasks', { projectId: p.id, title: 'Write hello.txt', difficulty: 'hard' })).body;
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

test('task difficulty picks the model via owner policy', async () => {
  const p = (await api('POST', '/api/projects', { name: 'D' })).body;
  const mk = async (difficulty?: string) => {
    const t = (await api('POST', '/api/tasks', { projectId: p.id, title: `t-${difficulty}`, assigneeId: 'technical-writer', difficulty })).body;
    await api('POST', `/api/tasks/${t.id}/run`);
    const r = ad.runs.at(-1)!; const model = r.spec.model; r.exit(1); await tick();
    return model;
  };
  assert.equal(await mk('easy'), 'haiku');
  assert.equal(await mk('medium'), 'sonnet');
  assert.equal(await mk('hard'), 'opus');
  assert.equal((await api('PUT', '/api/policies/models.byDifficulty', { value: { easy: 'gpt-4', medium: 'sonnet', hard: 'opus' } })).status, 400);
  assert.equal((await api('PUT', '/api/policies/models.byDifficulty', { value: { easy: 'sonnet', medium: 'opus', hard: 'opus' } })).status, 200);
  assert.equal(await mk('easy'), 'sonnet');
  assert.equal((await api('PUT', '/api/policies/runtime.maxConcurrentSessions', { value: -1 })).status, 400);
});

const done = (r: any, text: string, extra: object = {}) => {
  r.emit({ kind: 'init', claudeSessionId: extra['cid' as keyof object] ?? 'cid', model: r.spec.model, tools: [] });
  r.emit({ kind: 'result', ok: true, subtype: 'success', text, claudeSessionId: extra['cid' as keyof object] ?? 'cid', numTurns: 1, costUsdEstimate: 0, inputTokens: 1, outputTokens: 1, permissionDenials: [], ...extra });
  r.exit(0);
};
const settle = async () => { for (let i = 0; i < 4; i++) await tick(); };

test('no difficulty → department leader assesses (no tools), then work runs on the assessed model', async () => {
  await api('PUT', '/api/policies/models.byDifficulty', { value: { easy: 'haiku', medium: 'sonnet', hard: 'opus' } });
  const p = (await api('POST', '/api/projects', { name: 'A' })).body;
  const t = (await api('POST', '/api/tasks', { projectId: p.id, title: 'Fix typo in README', assigneeId: 'technical-writer' })).body;
  const sid = (await api('POST', `/api/tasks/${t.id}/run`)).body.sessionId;
  const assess = ad.runs.at(-1)!;
  const sess = (await api('GET', `/api/sessions/${sid}`)).body.session;
  assert.equal(sess.purpose, 'assess');
  assert.equal(sess.agent_id, 'docs-dir', 'the assignee\'s department leader assesses');
  assert.deepEqual(assess.spec.tools, []);
  assert.equal(assess.spec.model, 'sonnet');

  done(assess, 'Sure.\n{"difficulty":"easy","reason":"one-line docs change"}');
  await settle();
  const work = ad.runs.at(-1)!;
  assert.notEqual(work, assess);
  assert.equal(work.spec.model, 'haiku');
  const d = (await api('GET', `/api/tasks/${t.id}`)).body;
  assert.equal(d.task.difficulty, 'easy');
  assert.equal(d.task.status, 'RUNNING');
  assert.match(d.comments.at(-1).body, /Assessed difficulty: easy/);
  work.exit(1); await settle();
});

test('unreadable assessment defaults to medium', async () => {
  const p = (await api('POST', '/api/projects', { name: 'A2' })).body;
  const t = (await api('POST', '/api/tasks', { projectId: p.id, title: 'x', assigneeId: 'technical-writer' })).body;
  await api('POST', `/api/tasks/${t.id}/run`);
  done(ad.runs.at(-1)!, 'I think it is fine');
  await settle();
  assert.equal(ad.runs.at(-1)!.spec.model, 'sonnet');
  ad.runs.at(-1)!.exit(1); await settle();
});

test('design agents are fixed on opus: no assessment, difficulty ignored', async () => {
  const p = (await api('POST', '/api/projects', { name: 'UI' })).body;
  const t = (await api('POST', '/api/tasks', { projectId: p.id, title: 'Landing page', assigneeId: 'ui-ux-designer', difficulty: 'easy' })).body;
  const sid = (await api('POST', `/api/tasks/${t.id}/run`)).body.sessionId;
  assert.equal((await api('GET', `/api/sessions/${sid}`)).body.session.purpose, 'work');
  assert.equal(ad.runs.at(-1)!.spec.model, 'opus');
  assert.doesNotMatch(ad.runs.at(-1)!.spec.prompt, /ESCALATE/, 'fixed-model agents are never escalated');
  ad.runs.at(-1)!.exit(1); await settle();
  const org = (await api('GET', '/api/org')).body.agents;
  for (const id of ['prod-dir', 'ui-ux-designer', 'ux-researcher']) {
    const a = org.find((x: any) => x.id === id);
    assert.deepEqual([a.model, a.model_mode], ['opus', 'fixed'], id);
  }
});

test('ESCALATE line → difficulty +1, same conversation resumes on the stronger model', async () => {
  const p = (await api('POST', '/api/projects', { name: 'E' })).body;
  const t = (await api('POST', '/api/tasks', { projectId: p.id, title: 'Add caching', assigneeId: 'backend-developer', difficulty: 'easy' })).body;
  await api('POST', `/api/tasks/${t.id}/run`);
  const first = ad.runs.at(-1)!;
  assert.equal(first.spec.model, 'haiku');
  assert.match(first.spec.prompt, /ESCALATE:/);
  done(first, 'Looked around.\nESCALATE: needs cache invalidation design', { cid: 'conv-E' });
  await settle();

  const second = ad.runs.at(-1)!;
  assert.equal(second.spec.model, 'sonnet');
  assert.equal(second.spec.resumeSessionId, 'conv-E');
  let d = (await api('GET', `/api/tasks/${t.id}`)).body;
  assert.equal(d.task.difficulty, 'medium');
  assert.equal(d.task.status, 'RUNNING', 'escalation does not go through REVIEW');
  assert.match(d.comments.at(-1).body, /Escalated easy → medium \(haiku → sonnet\)/);

  // running out of turns also escalates
  second.emit({ kind: 'init', claudeSessionId: 'conv-E', model: 'sonnet', tools: [] });
  second.emit({ kind: 'result', ok: false, subtype: 'error_max_turns', text: '', claudeSessionId: 'conv-E', numTurns: 30, costUsdEstimate: 0, inputTokens: 1, outputTokens: 1, permissionDenials: [] });
  second.exit(1);
  await settle();
  const third = ad.runs.at(-1)!;
  assert.equal(third.spec.model, 'opus');
  assert.doesNotMatch(third.spec.prompt, /ESCALATE/, 'nothing above hard');

  // at hard, an ESCALATE line is just a normal completion
  done(third, 'Done.\nESCALATE: still hard', { cid: 'conv-E' });
  await settle();
  d = (await api('GET', `/api/tasks/${t.id}`)).body;
  assert.equal(d.task.status, 'REVIEW');
});

test('auto-escalation can be turned off by the owner', async () => {
  assert.equal((await api('PUT', '/api/policies/models.autoEscalate', { value: false })).status, 200);
  const p = (await api('POST', '/api/projects', { name: 'E2' })).body;
  const t = (await api('POST', '/api/tasks', { projectId: p.id, title: 'x', assigneeId: 'backend-developer', difficulty: 'easy' })).body;
  await api('POST', `/api/tasks/${t.id}/run`);
  assert.doesNotMatch(ad.runs.at(-1)!.spec.prompt, /ESCALATE/);
  done(ad.runs.at(-1)!, 'ESCALATE: hard');
  await settle();
  assert.equal((await api('GET', `/api/tasks/${t.id}`)).body.task.status, 'REVIEW');
  await api('PUT', '/api/policies/models.autoEscalate', { value: true });
});

test('CEO brief → read-only planning session → tasks with assignees and dependencies', async () => {
  const p = (await api('POST', '/api/projects', { name: 'Plan me' })).body;
  assert.equal((await api('POST', `/api/projects/${p.id}/brief`, { text: '' })).status, 400);
  const sid = (await api('POST', `/api/projects/${p.id}/brief`, { text: 'Add a contact form' })).body.sessionId;
  assert.equal((await api('POST', `/api/projects/${p.id}/brief`, { text: 'again' })).status, 400, 'one plan at a time');
  const run = ad.runs.at(-1)!;
  assert.equal(run.spec.model, 'opus');
  assert.deepEqual(run.spec.tools, ['Read', 'Glob', 'Grep'], 'CEO only reads while planning');
  assert.match(run.spec.prompt, /ui-ux-designer/);
  let st = (await api('GET', `/api/projects/${p.id}/status`)).body;
  assert.equal(st.planning.id, sid);

  const plan = { summary: 'Form + API + QA.', tasks: [
    { title: 'Design form', description: 'd', assignee: 'ui-ux-designer' },
    { title: 'API endpoint', description: 'd', assignee: 'backend-developer', priority: 1 },
    { title: 'Wire form', description: 'd', assignee: 'frontend-developer', dependsOn: [0, 1] },
    { title: 'QA', description: 'd', assignee: 'qa-engineer', dependsOn: [2, 9] },
    { title: 'Mystery', description: 'd', assignee: 'nobody' },
  ] };
  done(run, 'Looked at the code.\n```json\n' + JSON.stringify(plan) + '\n```', { cid: 'plan-1' });
  await settle();

  const { tasks, dependencies } = (await api('GET', `/api/tasks?projectId=${p.id}`)).body;
  assert.equal(tasks.length, 5);
  const byTitle = Object.fromEntries(tasks.map((t: any) => [t.title, t]));
  assert.equal(byTitle['Design form'].status, 'ASSIGNED');
  assert.equal(byTitle['API endpoint'].priority, 1);
  assert.equal(byTitle['Mystery'].status, 'BACKLOG', 'unknown assignee → unassigned');
  assert.equal(byTitle['Wire form'].difficulty, null, 'leaders rate difficulty, not the CEO');
  const depsOf = (t: string) => dependencies.filter((d: any) => d.task_id === byTitle[t].id).map((d: any) => d.depends_on).sort();
  assert.deepEqual(depsOf('Wire form'), [byTitle['Design form'].id, byTitle['API endpoint'].id].sort());
  assert.deepEqual(depsOf('QA'), [byTitle['Wire form'].id], 'invalid dependency index ignored');
  st = (await api('GET', `/api/projects/${p.id}/status`)).body;
  assert.equal(st.planning, null);
  assert.match(st.messages[0].body, /Created 5 task/);
  assert.equal(st.ready, 2, 'design + API are ready, the rest wait');

  // run-ready starts exactly the unblocked ones (design → work directly, API → leader assessment)
  const before = ad.runs.length;
  const rr = (await api('POST', `/api/projects/${p.id}/run-ready`)).body;
  assert.equal(rr.started, 2);
  assert.equal(ad.runs.length - before >= 1, true);
  for (const r of ad.runs.slice(before)) { r.exit(1); }
  await settle();
});

test('unreadable plan creates nothing and reports back', async () => {
  const p = (await api('POST', '/api/projects', { name: 'Bad plan' })).body;
  await api('POST', `/api/projects/${p.id}/brief`, { text: 'Do things' });
  done(ad.runs.at(-1)!, 'I am not sure what to do.');
  await settle();
  assert.equal((await api('GET', `/api/tasks?projectId=${p.id}`)).body.tasks.length, 0);
  assert.match((await api('GET', `/api/projects/${p.id}/status`)).body.messages[0].body, /could not produce a readable plan/);
});

test('delete project: refuses while a session is live; then removes tasks + sessions, keeps files', async () => {
  const p = (await api('POST', '/api/projects', { name: 'Throwaway' })).body;
  const a = (await api('POST', '/api/tasks', { projectId: p.id, title: 'A', assigneeId: 'backend-developer', difficulty: 'easy' })).body;
  const b = (await api('POST', '/api/tasks', { projectId: p.id, title: 'B', dependsOn: [a.id] })).body;
  await api('POST', `/api/tasks/${a.id}/comments`, { body: 'note' });
  await api('POST', `/api/tasks/${a.id}/run`);
  await tick();
  assert.equal((await api('GET', `/api/projects/${p.id}/footprint`)).body.liveSessions, 1);
  assert.equal((await api('DELETE', `/api/projects/${p.id}`)).status, 400, 'live session blocks delete');

  ad.runs.at(-1)!.exit(null); // session ends
  await tick();
  const f = (await api('GET', `/api/projects/${p.id}/footprint`)).body;
  assert.equal(f.tasks, 2); assert.equal(f.liveSessions, 0);
  const r = await api('DELETE', `/api/projects/${p.id}`);
  assert.equal(r.status, 200);
  assert.equal((await api('GET', `/api/tasks/${b.id}`)).status, 400);
  assert.ok(!(await api('GET', '/api/projects')).body.some((x: any) => x.id === p.id));
  assert.equal(Number((db.prepare('SELECT count(*) n FROM sessions WHERE task_id = ?').get(a.id) as any).n), 0);
  assert.equal(Number((db.prepare('SELECT count(*) n FROM task_comments WHERE task_id = ?').get(a.id) as any).n), 0);
});
