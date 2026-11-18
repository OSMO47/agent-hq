import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { openDb, setPolicy } from '../src/db.ts';
import { seed } from '../src/seed.ts';
import { SessionManager } from '../src/runtime/sessionManager.ts';
import { TaskRunner } from '../src/domain/taskRunner.ts';
import { SKILLS, DEFAULT_AGENT_SKILLS, syncSkills, skillsPrompt, agentSkillIds, setAgentSkills } from '../src/domain/skills.ts';
import { ScriptedAdapter, tick } from './helpers.ts';

/** A fake marketplace with every plugin skill file present. */
function fakeMarketplace(): string {
  const root = mkdtempSync(join(tmpdir(), 'hq-plugins-'));
  for (const s of SKILLS.filter((x) => x.source === 'plugin')) {
    const f = join(root, s.body);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, `---\nname: ${s.id}\ndescription: example noise\n---\n\nPLAYBOOK ${s.id}\n`);
  }
  return root;
}

test('every default mapping points at a real agent and a real skill', () => {
  const db = openDb(':memory:'); seed(db);
  const ids = new Set(SKILLS.map((s) => s.id));
  for (const [agent, skills] of Object.entries(DEFAULT_AGENT_SKILLS)) {
    assert.ok(db.prepare('SELECT 1 FROM agents WHERE id = ?').get(agent), `agent ${agent}`);
    for (const s of skills) assert.ok(ids.has(s), `skill ${s}`);
  }
  for (const a of db.prepare('SELECT id FROM agents').all() as { id: string }[]) assert.ok(DEFAULT_AGENT_SKILLS[a.id]?.length, `${a.id} has skills`);
});

test('sync loads plugin files (frontmatter stripped); owner-customized agents are left alone', () => {
  const db = openDb(':memory:'); seed(db);
  const r = syncSkills(db, fakeMarketplace());
  assert.equal(r.missing.length, 0);
  assert.equal(r.loaded.length, SKILLS.length);
  const fd = db.prepare("SELECT instructions FROM skills WHERE id = 'frontend-design'").get() as any;
  assert.equal(fd.instructions, 'PLAYBOOK frontend-design');
  assert.deepEqual(agentSkillIds(db, 'ui-ux-designer'), ['accessibility', 'frontend-design']);

  // Owner edits survive a restart.
  setAgentSkills(db, 'ui-ux-designer', ['ux-research'], 'owner');
  syncSkills(db, fakeMarketplace());
  assert.deepEqual(agentSkillIds(db, 'ui-ux-designer'), ['ux-research']);
  assert.throws(() => setAgentSkills(db, 'ui-ux-designer', ['nope'], 'owner'), /unknown skill/);
});

test('missing marketplace: builtins still load, plugin skills are skipped', () => {
  const db = openDb(':memory:'); seed(db);
  const r = syncSkills(db, join(tmpdir(), 'hq-no-such-dir'));
  assert.ok(r.missing.includes('frontend-design'));
  assert.deepEqual(agentSkillIds(db, 'security-analyst'), ['security-review']);
  assert.deepEqual(agentSkillIds(db, 'ui-ux-designer'), ['accessibility'], 'only the builtin part');
  assert.doesNotMatch(skillsPrompt(db, 'ui-ux-designer'), /Frontend design/);

  // Plugins installed later: non-customized agents pick them up on the next start.
  syncSkills(db, fakeMarketplace());
  assert.deepEqual(agentSkillIds(db, 'ui-ux-designer'), ['accessibility', 'frontend-design']);
});

test('builders get builder playbooks, not long reviewer prompts', () => {
  for (const b of ['backend-developer', 'frontend-developer', 'database-engineer', 'integration-engineer']) {
    assert.ok(!DEFAULT_AGENT_SKILLS[b].includes('silent-failure-hunter'), b);
    assert.ok(DEFAULT_AGENT_SKILLS[b].includes('testing'), `${b} writes tests`);
  }
  assert.ok(DEFAULT_AGENT_SKILLS.ceo.includes('project-management'));
});

test('work sessions carry the assignee skills; owner rule stays last', async () => {
  const db = openDb(':memory:'); seed(db); syncSkills(db, fakeMarketplace());
  setPolicy(db, 'org.autoPilot', false, 'test');
  db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'P')").run();
  db.prepare(`INSERT INTO tasks (id, project_id, title, status, assignee_id, difficulty) VALUES ('t1', 'p1', 'Build UI', 'ASSIGNED', 'frontend-developer', 'medium')`).run();
  const ad = new ScriptedAdapter();
  const runner = new TaskRunner(db, new SessionManager(db, ad), mkdtempSync(join(tmpdir(), 'hq-')));
  runner.run('t1', 'owner');
  await tick();
  const sp = ad.runs.at(-1)!.spec.systemPrompt!;
  assert.match(sp, /## Skill: Frontend design\nPLAYBOOK frontend-design/);
  assert.match(sp, /## Skill: Accessibility/);
  assert.doesNotMatch(sp, /PLAYBOOK code-reviewer/);
  assert.match(sp, /Working efficiently/);
  assert.ok(sp.indexOf('PLAYBOOK') < sp.indexOf('Never deploy'));
});
