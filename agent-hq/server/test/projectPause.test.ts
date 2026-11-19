import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { seed } from '../src/seed.ts';
import { createTask, readyTasks } from '../src/domain/tasks.ts';

test('paused project: its ready tasks are not started; others are; resuming brings them back', () => {
  const db = openDb(':memory:'); seed(db);
  db.prepare("INSERT INTO projects (id, name) VALUES ('a', 'A'), ('b', 'B')").run();
  const ta = createTask(db, { projectId: 'a', title: 'a1', actor: 'owner', assigneeId: 'frontend-developer' });
  const tb = createTask(db, { projectId: 'b', title: 'b1', actor: 'owner', assigneeId: 'frontend-developer' });
  assert.equal(readyTasks(db).length, 2);
  db.prepare("UPDATE projects SET status = 'paused' WHERE id = 'a'").run();
  assert.deepEqual(readyTasks(db).map((t) => t.id), [tb.id]);
  db.prepare("UPDATE projects SET status = 'active' WHERE id = 'a'").run();
  assert.ok(readyTasks(db).some((t) => t.id === ta.id));
});
