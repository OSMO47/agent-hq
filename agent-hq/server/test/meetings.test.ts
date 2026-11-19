import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, setPolicy } from '../src/db.ts';
import { seed } from '../src/seed.ts';
import { SessionManager } from '../src/runtime/sessionManager.ts';
import { MeetingRoom, parseSummary, parseAttendees } from '../src/domain/meetings.ts';
import { getTask } from '../src/domain/tasks.ts';
import { ScriptedAdapter, tick } from './helpers.ts';

function setup() {
  const db = openDb(':memory:'); seed(db);
  setPolicy(db, 'runtime.maxConcurrentSessions', 3, 'test');
  db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'N5')").run();
  const ad = new ScriptedAdapter();
  const sm = new SessionManager(db, ad);
  const room = new MeetingRoom(db, sm, mkdtempSync(join(tmpdir(), 'hq-meet-')));
  return { db, ad, sm, room };
}
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
async function speak(ad: ScriptedAdapter, text: string) {
  const run = ad.runs.at(-1)!;
  run.emit({ kind: 'result', ok: true, subtype: 'success', text, claudeSessionId: 'c', numTurns: 1, costUsdEstimate: 0, inputTokens: 1, outputTokens: 1, permissionDenials: [] });
  run.exit(0);
  await settle();
}

test('meeting: speakers take turns (read-only, each sees what was said), CEO summarizes into idea cards', async () => {
  const { db, ad, room } = setup();
  const m = room.start({ projectId: 'p1', topic: 'ทำให้ผู้เรียนกลับมาเรียนทุกวัน', participants: ['prod-dir', 'frontend-developer'], rounds: 2, actor: 'owner' });
  await settle();
  assert.equal(ad.runs.length, 1, 'one speaker at a time');
  assert.deepEqual(ad.runs[0].spec.tools, ['Read', 'Glob', 'Grep'], 'read-only');
  assert.equal(ad.runs[0].spec.model, 'opus', 'meetings run on the meeting model (opus)');
  assert.match(ad.runs[0].spec.prompt, /รอบ 1\/2/);

  await speak(ad, '- แจ้งเตือนสตรีค');
  assert.equal(ad.runs[1].spec.model, 'opus', 'others use the meeting model');
  assert.match(ad.runs[1].spec.prompt, /แจ้งเตือนสตรีค/, 'second speaker sees the first');
  await speak(ad, '- ภารกิจประจำวันกดแล้วไปบทเรียนเลย');
  await speak(ad, '- เห็นด้วย');
  await speak(ad, '- รวมสองข้อ');
  assert.equal(room.get(m.id)!.status, 'summarizing');
  assert.match(ad.runs[4].spec.systemPrompt!, /Chief Orchestrator/, 'the CEO chairs the summary');
  assert.deepEqual(ad.runs[4].spec.tools, []);

  await speak(ad, 'สรุป\n```json\n{"summary":"ทีมเห็นตรงกัน","ideas":[{"title":"ภารกิจกดแล้วไปบทเรียน","description":"ลิงก์การ์ดภารกิจ","why":"หาง่าย","assignee":"frontend-developer"},{"title":"แจ้งเตือนสตรีค","description":"","why":"","assignee":"nobody"}]}\n```');
  const done = room.get(m.id)!;
  assert.equal(done.status, 'done');
  assert.equal(done.summary, 'ทีมเห็นตรงกัน');
  const ideas = db.prepare('SELECT * FROM meeting_ideas WHERE meeting_id = ? ORDER BY rowid').all(m.id) as any[];
  assert.equal(ideas.length, 2);
  assert.equal(ideas[1].assignee_id, null, 'unknown assignee dropped');
  assert.equal((db.prepare('SELECT COUNT(*) n FROM meeting_messages WHERE meeting_id = ?').get(m.id) as any).n, 4);

  room.decide(ideas[0].id, true, 'owner');
  const t = getTask(db, (db.prepare('SELECT task_id FROM meeting_ideas WHERE id = ?').get(ideas[0].id) as any).task_id)!;
  assert.equal(t.project_id, 'p1'); assert.equal(t.assignee_id, 'frontend-developer'); assert.equal(t.status, 'ASSIGNED');
  room.decide(ideas[1].id, false, 'owner');
  assert.throws(() => room.decide(ideas[1].id, true, 'owner'), /already rejected/);
});

test('meeting: validation, stop, and a failed turn ends the meeting', async () => {
  const { ad, room } = setup();
  assert.throws(() => room.start({ projectId: 'p1', topic: 'x', participants: ['prod-dir'], actor: 'owner' }), /at least 2/);
  assert.throws(() => room.start({ projectId: 'p1', topic: ' ', participants: ['prod-dir', 'qa-dir'], actor: 'owner' }), /empty/);
  const m = room.start({ projectId: 'p1', topic: 'x', participants: ['prod-dir', 'qa-dir'], rounds: 1, actor: 'owner' });
  await settle();
  room.stop(m.id, 'owner'); await settle();
  assert.equal(room.get(m.id)!.status, 'stopped');
  assert.equal(ad.runs[0].stopped, true);

  const m2 = room.start({ projectId: 'p1', topic: 'y', participants: ['prod-dir', 'qa-dir'], rounds: 1, actor: 'owner' });
  await settle();
  ad.runs.at(-1)!.exit(1); await settle();
  assert.equal(room.get(m2.id)!.status, 'failed');
});

test('parseSummary tolerates prose around the JSON', () => {
  assert.equal(parseSummary('ok {"summary":"s","ideas":[{"title":"a"}]} end')!.ideas.length, 1);
  assert.equal(parseSummary('no json'), null);
});

test('meeting plan: CEO picks attendees, owner edits and approves, then the meeting starts ', async () => {
  const { db, ad, room } = setup();
  const plan = room.propose({ projectId: 'p1', topic: 'ปรับหน้าตาแอป', rounds: 1, actor: 'owner' });
  await settle();
  assert.equal(ad.runs.length, 1);
  assert.deepEqual(ad.runs[0].spec.tools, []);
  assert.equal(ad.runs[0].spec.model, 'opus');
  assert.match(ad.runs[0].spec.prompt, /ปรับหน้าตาแอป/);
  assert.equal(room.getPlan(plan.id)!.status, 'selecting');
  assert.throws(() => room.approvePlan(plan.id, undefined, undefined, 'owner'), /not waiting/);

  await speak(ad, '{"participants":[{"id":"prod-dir","why":"ดูแลดีไซน์"},{"id":"nobody","why":"x"},{"id":"ceo","why":"x"},{"id":"qa-dir","why":"ทดสอบ"}],"note":"ok"}');
  const p = room.getPlan(plan.id)!;
  assert.equal(p.status, 'proposed');
  assert.deepEqual((JSON.parse(p.suggested) as any[]).map((x) => x.id), ['prod-dir', 'qa-dir'], 'unknown ids and the CEO are dropped');
  assert.equal(ad.runs.length, 1, 'nothing starts before the owner approves');

  const m = room.approvePlan(plan.id, ['prod-dir', 'qa-dir', 'frontend-developer'], undefined, 'owner');
  assert.deepEqual(JSON.parse(m.participants), ['prod-dir', 'qa-dir', 'frontend-developer'], 'owner added a member');
  assert.equal(m.rounds, 1);
  assert.equal(room.getPlan(plan.id)!.status, 'started');
  await settle();
  assert.equal(ad.runs[1].spec.model, 'opus');
  assert.ok(db.prepare('SELECT 1 FROM meetings WHERE id = ?').get(m.id));
});

test('meeting plan: too few picks fails, cancel works, policy model is honoured', async () => {
  const { db, ad, room } = setup();
  const a = room.propose({ projectId: 'p1', topic: 'x', actor: 'owner' }); await settle();
  await speak(ad, '{"participants":[{"id":"prod-dir"}]}');
  assert.equal(room.getPlan(a.id)!.status, 'failed');
  const b = room.propose({ projectId: 'p1', topic: 'y', actor: 'owner' }); await settle();
  room.cancelPlan(b.id, 'owner');
  assert.equal(room.getPlan(b.id)!.status, 'cancelled');
  setPolicy(db, 'models.meeting', 'sonnet', 'test');
  room.propose({ projectId: 'p1', topic: 'z', actor: 'owner' }); await settle();
  assert.equal(ad.runs.at(-1)!.spec.model, 'sonnet');
  assert.equal(parseAttendees('no json'), null);
});
