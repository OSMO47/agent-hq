import { type DB, tx, audit, setPolicy } from './db.ts';

/** Tool permission presets. Anything not allowed is denied in `claude -p` (no interactive prompt). */
export const PERMISSIONS = {
  planner: { permissionMode: 'default', tools: ['Read', 'Glob', 'Grep'], allowedTools: ['Read', 'Glob', 'Grep'], disallowedTools: [] as string[] },
  builder: {
    permissionMode: 'default',
    tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
    allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash(git status:*)', 'Bash(git diff:*)',
      'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(node:*)'],
    disallowedTools: ['Bash(git push:*)', 'Bash(rm:*)', 'Bash(curl:*)', 'WebFetch'],
  },
};

export const DEFAULT_POLICIES: Record<string, unknown> = {
  'runtime.defaultModel': 'opus',
  'models.byDifficulty': { easy: 'haiku', medium: 'sonnet', hard: 'opus' },
  'models.assessment': 'sonnet',      // model leaders use to rate task difficulty (no tools, ~4k tokens)
  'models.autoEscalate': true,          // harder than expected -> next difficulty, same conversation
  'runtime.maxConcurrentSessions': 2,
  'runtime.sessionTimeoutMs': 20 * 60_000,
  'runtime.maxTurnsPerSession': 30,
  'org.paused': false,
  'recruitment.requiresOwnerApproval': true,
  'recruitment.maxAgents': 40,
};

const DEPARTMENTS: [id: string, name: string, leader: [id: string, name: string, role: string]][] = [
  ['tech', 'Technology', ['cto', 'Kenji', 'CTO / Technical Director']],
  ['eng', 'Engineering', ['eng-dir', 'Haruto', 'Engineering Director']],
  ['qa', 'Quality Assurance', ['qa-dir', 'Yui', 'QA Director']],
  ['sec', 'Security', ['sec-dir', 'Ren', 'Security Director']],
  ['product', 'Product & Design', ['prod-dir', 'Sakura', 'Product & Design Director']],
  ['docs', 'Documentation', ['docs-dir', 'Aoi', 'Documentation Director']],
];

const SPECIALISTS: [dept: string, reportsTo: string, role: string, model: string, preset: keyof typeof PERMISSIONS][] = [
  ['eng', 'eng-dir', 'System Architect', 'opus', 'planner'],
  ['eng', 'eng-dir', 'Backend Developer', 'opus', 'builder'],
  ['eng', 'eng-dir', 'Frontend Developer', 'opus', 'builder'],
  ['eng', 'eng-dir', 'Database Engineer', 'opus', 'builder'],
  ['eng', 'eng-dir', 'Integration Engineer', 'opus', 'builder'],
  ['product', 'prod-dir', 'Product Manager', 'opus', 'planner'],
  ['product', 'prod-dir', 'UI/UX Designer', 'opus', 'builder'],
  ['product', 'prod-dir', 'UX Researcher', 'opus', 'planner'],
  ['qa', 'qa-dir', 'QA Engineer', 'opus', 'builder'],
  ['qa', 'qa-dir', 'Automation Tester', 'opus', 'builder'],
  ['qa', 'qa-dir', 'Performance Tester', 'opus', 'builder'],
  ['sec', 'sec-dir', 'Security Analyst', 'opus', 'planner'],
  ['sec', 'sec-dir', 'Application Security Engineer', 'opus', 'builder'],
  ['docs', 'docs-dir', 'Technical Writer', 'opus', 'builder'],
  ['docs', 'docs-dir', 'Documentation Engineer', 'opus', 'builder'],
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Seed policies + the initial organization. Idempotent: does nothing if a CEO already exists. */
export function seed(db: DB): boolean {
  for (const [k, v] of Object.entries(DEFAULT_POLICIES)) {
    if (!db.prepare('SELECT 1 FROM policies WHERE key = ?').get(k) && db.prepare("SELECT 1 FROM agents WHERE id = 'ceo'").get()) setPolicy(db, k, v, 'system');
  }
  if (db.prepare("SELECT 1 FROM agents WHERE id = 'ceo'").get()) return false;
  tx(db, () => {
    for (const [k, v] of Object.entries(DEFAULT_POLICIES)) setPolicy(db, k, v, 'system');

    const insAgent = db.prepare(`INSERT INTO agents (id, name, role, level, department_id, reports_to, model, instructions, permissions)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insAgent.run('ceo', 'Akira', 'CEO / Chief Orchestrator', 1, null, null, 'opus',
      'You lead the AI organization. Analyze owner requirements, plan, break work into tasks, delegate to department leaders, review reports, and escalate important decisions to the owner. Never grant yourself permissions.',
      JSON.stringify(PERMISSIONS.planner));

    const insDept = db.prepare('INSERT INTO departments (id, name, leader_id) VALUES (?, ?, ?)');
    for (const [id, name, [lid, lname, lrole]] of DEPARTMENTS) {
      insDept.run(id, name, lid);
      insAgent.run(lid, lname, lrole, 2, id, 'ceo', 'opus',
        `You are the ${lrole}. Break assignments from the CEO into subtasks, delegate to your team, review their work, report progress and blockers, and submit recruitment requests when a capability is missing.`,
        JSON.stringify(PERMISSIONS.planner));
    }
    for (const [dept, boss, role, model, preset] of SPECIALISTS) {
      insAgent.run(slug(role), role, role, 3, dept, boss, model,
        `You are a ${role}. Complete the assigned task inside your workspace, keep changes focused, and finish with a short report: what you did, files changed, open issues.`,
        JSON.stringify(PERMISSIONS[preset]));
    }
    // Owner rule: design / UX / UI work always runs on opus, regardless of difficulty.
    db.prepare("UPDATE agents SET model = 'opus', model_mode = 'fixed' WHERE id IN ('prod-dir', 'ui-ux-designer', 'ux-researcher')").run();
    db.prepare(`INSERT INTO memories (scope, key, content, protected, updated_by) VALUES ('global', 'policy.owner-authority', ?, 1, 'system')`)
      .run('The human owner has final authority. Agents may request, never self-approve, permissions, recruitment or policy changes.');
    audit(db, 'system', 'org.seed', null, { departments: DEPARTMENTS.length, specialists: SPECIALISTS.length });
  });
  return true;
}
