import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { seed } from '../src/seed.ts';
import { ROSTER } from '../src/roster.ts';

test('fresh install: every agent has its roster name and a position; tiers are GM / leaders / members', () => {
  const db = openDb(':memory:'); seed(db);
  const agents = db.prepare('SELECT id, name, role, title, level FROM agents').all() as any[];
  assert.equal(agents.length, Object.keys(ROSTER).length);
  for (const a of agents) {
    assert.equal(a.name, ROSTER[a.id].name, a.id);
    assert.equal(a.title, ROSTER[a.id].title, a.id);
  }
  assert.deepEqual(agents.filter((a) => a.level === 1).map((a) => a.name), ['Rakko']);
  assert.equal(agents.filter((a) => a.level === 2).length, 6);
  assert.equal(new Set(agents.map((a) => a.name)).size, agents.length, 'names are unique');
});

test('upgrade: old database gets names + positions, but owner-chosen names are kept', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hq-roster-')), 'hq.db');
  const db = openDb(file); seed(db);
  // simulate the previous version: no title column values, specialists named after their role, one owner rename
  db.exec("UPDATE agents SET title = NULL; UPDATE agents SET name = role WHERE level = 3; UPDATE agents SET name = 'Boss' WHERE id = 'qa-engineer'");
  db.close();
  const db2 = openDb(file);
  const get = (id: string) => db2.prepare('SELECT name, title FROM agents WHERE id = ?').get(id) as any;
  assert.deepEqual({ ...get('backend-developer') }, { name: 'Kinako', title: 'Backend Developer' });
  assert.equal(get('qa-engineer').name, 'Boss', 'owner rename survives');
  assert.equal(get('ceo').title, 'General Manager');
});

test('personality: in free-text work prompts, never in JSON-only ones; a cleared one stays cleared', async () => {
  const { setPolicy } = await import('../src/db.ts');
  const { SessionManager } = await import('../src/runtime/sessionManager.ts');
  const { TaskRunner, personalityPrompt } = await import('../src/domain/taskRunner.ts');
  const { createTask } = await import('../src/domain/tasks.ts');
  const { ScriptedAdapter, tick } = await import('./helpers.ts');

  const file = join(mkdtempSync(join(tmpdir(), 'hq-persona-')), 'hq.db');
  const db = openDb(file); seed(db);
  assert.match(personalityPrompt(db, 'sec-dir'), /tone only/);
  assert.ok(personalityPrompt(db, 'sec-dir').includes(ROSTER['sec-dir'].personality));

  setPolicy(db, 'runtime.maxConcurrentSessions', 5, 'test');
  db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'P')").run();
  const ad = new ScriptedAdapter();
  const runner = new TaskRunner(db, new SessionManager(db, ad), mkdtempSync(join(tmpdir(), 'hq-')));
  // unassigned → the CEO dispatches (JSON answer): no personality there
  createTask(db, { projectId: 'p1', title: 'Unassigned thing' });
  runner.autoPilot(); await tick();
  const dispatch = ad.runs.at(-1)!.spec;
  assert.doesNotMatch(dispatch.systemPrompt!, /Your personality/);
  // assigned with a difficulty → straight to work: personality present, before the owner rule
  const t = createTask(db, { projectId: 'p1', title: 'Write docs', assigneeId: 'technical-writer', difficulty: 'easy' });
  runner.run(t.id, 'owner'); await tick();
  const work = ad.runs.at(-1)!.spec.systemPrompt!;
  assert.ok(work.includes(ROSTER['technical-writer'].personality));
  assert.ok(work.indexOf('Your personality') < work.indexOf('Never deploy'));

  // owner clears a personality: it stays empty across restarts
  db.prepare("UPDATE agents SET personality = '' WHERE id = 'cto'").run();
  db.close();
  const db2 = openDb(file);
  assert.equal((db2.prepare("SELECT personality FROM agents WHERE id = 'cto'").get() as any).personality, '');
  assert.equal(personalityPrompt(db2, 'cto'), '');
});
