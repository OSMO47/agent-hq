import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, setPolicy } from '../src/db.ts';
import { seed } from '../src/seed.ts';
import { SessionManager } from '../src/runtime/sessionManager.ts';
import { TaskRunner } from '../src/domain/taskRunner.ts';
import { createTask, getTask, addDependency } from '../src/domain/tasks.ts';
import { ScriptedAdapter, tick } from './helpers.ts';

function setup() {
  const db = openDb(':memory:');
  seed(db);
  setPolicy(db, 'runtime.maxConcurrentSessions', 5, 'test');
  db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'P')").run();
  const ad = new ScriptedAdapter();
  const sm = new SessionManager(db, ad);
  const runner = new TaskRunner(db, sm, mkdtempSync(join(tmpdir(), 'hq-')));
  return { db, ad, sm, runner };
}
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
/** Finish the newest run that is still open with the given reply. */
async function reply(ad: ScriptedAdapter, text: string, extra: object = {}) {
  const run = ad.runs.findLast((r) => !(r as any).done)!;
  (run as any).done = true;
  run.emit({ kind: 'init', claudeSessionId: `c${ad.runs.length}`, model: 'x', tools: [] });
  run.emit({ kind: 'result', ok: true, subtype: 'success', text, claudeSessionId: `c${ad.runs.length}`, numTurns: 1,
    costUsdEstimate: 0, inputTokens: 1, outputTokens: 1, permissionDenials: [], ...extra });
  run.exit(0);
  await settle();
  return run;
}

test('autopilot: CEO assigns → leader rates → work runs → clean report is auto-approved → dependent starts', async () => {
  const { db, ad, runner } = setup();
  const a = createTask(db, { projectId: 'p1', title: 'Fix quest link on home', actor: 'owner' });
  const b = createTask(db, { projectId: 'p1', title: 'QA the fix', assigneeId: 'qa-engineer', difficulty: 'easy', dependsOn: [a.id], actor: 'owner' });
  runner.autoPilot(); await settle();

  assert.equal(ad.runs.length, 1, 'only the dispatch runs; b waits on a');
  assert.match(ad.runs[0].spec.prompt, /dispatching one task/);
  assert.deepEqual(ad.runs[0].spec.tools, []);
  await reply(ad, '{"assignee":"frontend-developer","reason":"UI navigation"}');
  assert.equal(getTask(db, a.id)!.assignee_id, 'frontend-developer');

  assert.match(ad.runs[1].spec.prompt, /Rate its difficulty/, 'leader rates difficulty');
  await reply(ad, '{"difficulty":"easy","reason":"small"}');
  assert.match(ad.runs[2].spec.prompt, /NEEDS_OWNER/, 'work prompt explains how to ask the owner');
  await reply(ad, 'Done: quest card now links to the lesson.');
  assert.equal(getTask(db, a.id)!.status, 'DONE');
  assert.equal(getTask(db, a.id)!.review_status, 'approved');

  assert.equal(getTask(db, b.id)!.status, 'RUNNING', 'dependent task started by itself');
});

test('autopilot: NEEDS_OWNER or an unexpected blocked tool stops at REVIEW for the owner', async () => {
  const { db, ad, runner } = setup();
  const t = createTask(db, { projectId: 'p1', title: 'Restyle', assigneeId: 'frontend-developer', difficulty: 'easy', actor: 'owner' });
  runner.autoPilot(); await settle();
  await reply(ad, 'Done.\nNEEDS_OWNER: Keep the old pink or switch to sakura?');
  assert.equal(getTask(db, t.id)!.status, 'REVIEW');
  assert.equal(getTask(db, t.id)!.review_status, 'pending');
  const c = db.prepare("SELECT body FROM task_comments WHERE task_id = ? AND author = 'system'").get(t.id) as any;
  assert.match(c.body, /sakura/);

  const u = createTask(db, { projectId: 'p1', title: 'Install dep', assigneeId: 'frontend-developer', difficulty: 'easy', actor: 'owner' });
  runner.autoPilot(); await settle();
  await reply(ad, 'Could not install.', { permissionDenials: [{ tool: 'Bash', input: { command: 'npm install left-pad' } }] });
  assert.equal(getTask(db, u.id)!.status, 'REVIEW', 'unexpected denial needs the owner');

  const v = createTask(db, { projectId: 'p1', title: 'Ship', assigneeId: 'frontend-developer', difficulty: 'easy', actor: 'owner' });
  runner.autoPilot(); await settle();
  await reply(ad, 'Changed it. I did not deploy.', { permissionDenials: [{ tool: 'Bash', input: { command: 'firebase deploy' } }] });
  assert.equal(getTask(db, v.id)!.status, 'DONE', 'blocked deploy is expected, not a question');
});

test('autopilot respects pause and can be switched off', async () => {
  const { db, ad, runner } = setup();
  setPolicy(db, 'org.paused', true, 'test');
  createTask(db, { projectId: 'p1', title: 'x', actor: 'owner' });
  runner.autoPilot(); await settle();
  assert.equal(ad.runs.length, 0);
  setPolicy(db, 'org.paused', false, 'test');
  setPolicy(db, 'org.autoPilot', false, 'test');
  runner.autoPilot(); await settle();
  assert.equal(ad.runs.length, 0);
});
