import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getPolicy, setPolicy } from '../src/db.ts';
import { seed } from '../src/seed.ts';
import { createTask, transition, claimTask, readyTasks, addDependency, TaskError } from '../src/domain/tasks.ts';

function fresh() {
  const db = openDb(':memory:');
  seed(db);
  db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'Demo')").run();
  return db;
}

test('seed creates CEO, 6 leaders, 15 specialists, policies; is idempotent', () => {
  const db = fresh();
  const count = (lvl: number) => (db.prepare('SELECT COUNT(*) n FROM agents WHERE level = ?').get(lvl) as any).n;
  assert.equal(count(1), 1);
  assert.equal(count(2), 6);
  assert.equal(count(3), 15);
  assert.equal((db.prepare("SELECT model FROM agents WHERE id='ceo'").get() as any).model, 'opus');
  assert.equal(getPolicy(db, 'runtime.maxConcurrentSessions', 0), 2);
  assert.equal(seed(db), false);
  // every specialist reports to its department leader
  const orphans = db.prepare('SELECT a.id FROM agents a JOIN departments d ON d.id = a.department_id WHERE a.level = 3 AND a.reports_to <> d.leader_id').all();
  assert.deepEqual(orphans, []);
});

test('policy changes are audited', () => {
  const db = fresh();
  setPolicy(db, 'runtime.maxConcurrentSessions', 3, 'owner');
  const row = db.prepare("SELECT actor FROM audit_log WHERE action='policy.set' AND target='runtime.maxConcurrentSessions' ORDER BY id DESC").get() as any;
  assert.equal(row.actor, 'owner');
});

test('task lifecycle enforces legal transitions', () => {
  const db = fresh();
  const t = createTask(db, { projectId: 'p1', title: 'x' });
  assert.equal(t.status, 'BACKLOG');
  assert.throws(() => transition(db, t.id, 'DONE', 'owner'), TaskError);
  assert.throws(() => transition(db, t.id, 'RUNNING', 'owner'), /claimTask/);
  transition(db, t.id, 'PLANNED', 'ceo');
  transition(db, t.id, 'CANCELLED', 'owner');
  assert.throws(() => transition(db, t.id, 'ASSIGNED', 'owner'), TaskError);
});

test('dependencies block execution and cycles are rejected', () => {
  const db = fresh();
  const a = createTask(db, { projectId: 'p1', title: 'api', assigneeId: 'backend-developer' });
  const b = createTask(db, { projectId: 'p1', title: 'ui', assigneeId: 'frontend-developer', dependsOn: [a.id] });
  assert.throws(() => addDependency(db, a.id, b.id), /cycle/);
  assert.deepEqual(readyTasks(db).map((t) => t.id), [a.id]);
  assert.throws(() => claimTask(db, b.id, 's1', 'sys'), /unmet dependencies/);

  claimTask(db, a.id, 's1', 'sys');
  transition(db, a.id, 'REVIEW', 'backend-developer');
  transition(db, a.id, 'DONE', 'qa-dir');
  assert.deepEqual(readyTasks(db).map((t) => t.id), [b.id]);
});

test('claimTask prevents duplicate execution', () => {
  const db = fresh();
  const t = createTask(db, { projectId: 'p1', title: 'x', assigneeId: 'backend-developer' });
  const c = claimTask(db, t.id, 's1', 'sys');
  assert.equal(c.status, 'RUNNING');
  assert.equal(c.lock_session, 's1');
  assert.throws(() => claimTask(db, t.id, 's2', 'sys'), /not claimable/);
  // failure releases the lock; retry is possible and attempts increments
  transition(db, t.id, 'FAILED', 'sys');
  transition(db, t.id, 'ASSIGNED', 'owner');
  assert.equal(claimTask(db, t.id, 's3', 'sys').attempts, 2);
});
