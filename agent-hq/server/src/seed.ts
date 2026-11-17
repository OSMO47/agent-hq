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
  ['eng', 'eng-dir', 'System Architect', 'sonnet', 'planner'],
  ['eng', 'eng-dir', 'Backend Developer', 'sonnet', 'builder'],
  ['eng', 'eng-dir', 'Frontend Developer', 'sonnet', 'builder'],
  ['eng', 'eng-dir', 'Database Engineer', 'sonnet', 'builder'],
  ['eng', 'eng-dir', 'Integration Engineer', 'sonnet', 'builder'],
  ['product', 'prod-dir', 'Product Manager', 'sonnet', 'planner'],
  ['product', 'prod-dir', 'UI/UX Designer', 'sonnet', 'builder'],
  ['product', 'prod-dir', 'UX Researcher', 'haiku', 'planner'],
  ['qa', 'qa-dir', 'QA Engineer', 'sonnet', 'builder'],
  ['qa', 'qa-dir', 'Automation Tester', 'sonnet', 'builder'],
  ['qa', 'qa-dir', 'Performance Tester', 'sonnet', 'builder'],
  ['sec', 'sec-dir', 'Security Analyst', 'sonnet', 'planner'],
  ['sec', 'sec-dir', 'Application Security Engineer', 'sonnet', 'builder'],
  ['docs', 'docs-dir', 'Technical Writer', 'haiku', 'builder'],
  ['docs', 'docs-dir', 'Documentation Engineer', 'haiku', 'builder'],
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Seed policies + the initial organization. Idempotent: does nothing if a CEO already exists. */
export function seed(db: DB): boolean {
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
      insAgent.run(lid, lname, lrole, 2, id, 'ceo', 'sonnet',
        `You are the ${lrole}. Break assignments from the CEO into subtasks, delegate to your team, review their work, report progress and blockers, and submit recruitment requests when a capability is missing.`,
        JSON.stringify(PERMISSIONS.planner));
    }
    for (const [dept, boss, role, model, preset] of SPECIALISTS) {
      insAgent.run(slug(role), role, role, 3, dept, boss, model,
        `You are a ${role}. Complete the assigned task inside your workspace, keep changes focused, and finish with a short report: what you did, files changed, open issues.`,
        JSON.stringify(PERMISSIONS[preset]));
    }
    db.prepare(`INSERT INTO memories (scope, key, content, protected, updated_by) VALUES ('global', 'policy.owner-authority', ?, 1, 'system')`)
      .run('The human owner has final authority. Agents may request, never self-approve, permissions, recruitment or policy changes.');
    audit(db, 'system', 'org.seed', null, { departments: DEPARTMENTS.length, specialists: SPECIALISTS.length });
  });
  return true;
}
