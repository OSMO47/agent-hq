import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type DB, tx, audit } from '../db.ts';

/**
 * Agent skills: playbooks appended to an agent's system prompt for real work (tasks, follow-ups).
 * Two sources:
 *  - 'plugin': read at startup from the official Claude Code plugin marketplace installed on this machine
 *    (~/.claude/plugins/marketplaces/claude-plugins-official, Apache-2.0). Nothing is copied into this repo;
 *    if the file is missing the skill is simply not available.
 *  - 'builtin': short playbooks written for OSMO AGENT, for roles the marketplace does not cover.
 */
export interface SkillDef {
  id: string; name: string; description: string;
  source: 'plugin' | 'builtin';
  /** plugin: path under the marketplace root; builtin: the playbook text. */
  body: string;
}

export const MARKETPLACE = 'claude-plugins-official';
export const defaultPluginRoot = () =>
  process.env.HQ_PLUGIN_DIR ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'plugins', 'marketplaces', MARKETPLACE);

const plugin = (id: string, name: string, description: string, path: string): SkillDef => ({ id, name, description, source: 'plugin', body: path });
const builtin = (id: string, name: string, description: string, ...lines: string[]): SkillDef => ({ id, name, description, source: 'builtin', body: lines.join('\n') });

export const SKILLS: SkillDef[] = [
  // --- from the official plugin marketplace ---
  plugin('frontend-design', 'Frontend design', 'Distinctive, production-grade interfaces; avoids generic AI look', 'plugins/frontend-design/skills/frontend-design/SKILL.md'),
  plugin('code-architect', 'Code architecture', 'Feature architecture from existing patterns: files, components, build sequence', 'plugins/feature-dev/agents/code-architect.md'),
  plugin('code-explorer', 'Codebase exploration', 'Trace execution paths and map how a feature works before changing it', 'plugins/feature-dev/agents/code-explorer.md'),
  plugin('code-reviewer', 'Code review', 'Confidence-filtered review for bugs, security and convention issues', 'plugins/feature-dev/agents/code-reviewer.md'),
  plugin('silent-failure-hunter', 'Error handling audit', 'Find swallowed errors, silent fallbacks and unactionable failures', 'plugins/pr-review-toolkit/agents/silent-failure-hunter.md'),
  plugin('pr-test-analyzer', 'Test coverage analysis', 'Judge whether tests cover the behaviour that matters, find critical gaps', 'plugins/pr-review-toolkit/agents/pr-test-analyzer.md'),
  plugin('type-design-analyzer', 'Type design', 'Types that encode invariants and make bad states unrepresentable', 'plugins/pr-review-toolkit/agents/type-design-analyzer.md'),
  plugin('code-simplifier', 'Code simplification', 'Simplify recently changed code without changing behaviour', 'plugins/code-simplifier/agents/code-simplifier.md'),
  plugin('comment-analyzer', 'Comment accuracy', 'Check comments and docs against the code; remove rot', 'plugins/pr-review-toolkit/agents/comment-analyzer.md'),

  // --- OSMO AGENT playbooks ---
  builtin('leader-delegation', 'Leading a department', 'Break work down, delegate, review, report',
    '- Split an assignment into tasks one specialist can finish in one session; each with a clear done-condition.',
    '- Give every task the context the specialist lacks: goal, files or areas involved, constraints, how to verify.',
    '- Rate difficulty honestly (easy / medium / hard); design, UX and UI work stays on opus.',
    '- Review results against the done-condition, not the effort. Send back with concrete notes when it misses.',
    '- Report up in a few lines: done, in progress, blocked (and what unblocks it). Escalate only real decisions.',
    '- If a capability is missing from the team, propose a recruitment request instead of stretching a role.'),
  builtin('security-review', 'Security review', 'Find exploitable issues in changed code, with evidence',
    '- Start from trust boundaries: every input from users, network, files, env, other processes.',
    '- Check: injection (SQL, shell, path, template), authn/authz on every route, secrets in code or logs,',
    '  unsafe deserialization, SSRF, XSS / unsafe HTML, CSRF, open redirects, weak crypto or randomness, dependency risk.',
    '- Only report what you can show: file:line, the input that reaches it, and the impact. No speculative noise.',
    '- Rank by exploitability x impact. For each finding give the smallest safe fix.',
    '- Never test against live systems or exfiltrate data; reason from the code and local runs only.'),
  builtin('product-spec', 'Product specs', 'Turn a request into a buildable, testable spec',
    '- State the user problem and who has it before any solution.',
    '- Write the smallest version that solves it; list what is explicitly out of scope.',
    '- Acceptance criteria as checkable statements (Given / When / Then where it helps).',
    '- Note open questions and the decision each one blocks; flag ones only the owner can answer with NEEDS_OWNER.',
    '- Break the spec into tasks ordered by dependency, each independently verifiable.'),
  builtin('ux-research', 'UX research', 'Evidence about users before and after design',
    '- Begin with the questions the research must answer and the decision it informs.',
    '- Use what exists first: the current UI, copy, flows, error states, analytics or logs in the repo.',
    '- Walk the main flows as a first-time user; record friction with the exact screen and step.',
    '- Separate observation from interpretation from recommendation.',
    '- Recommend changes ranked by user impact and effort; hand UI work to the UI/UX Designer.'),
  builtin('database-engineering', 'Database engineering', 'Schemas, migrations and queries that stay correct',
    '- Model constraints in the schema (NOT NULL, CHECK, FK, UNIQUE) rather than only in code.',
    '- Migrations are additive and idempotent; never drop or rewrite data without an explicit task saying so.',
    '- Every multi-statement write runs in a transaction; think about concurrent writers.',
    '- Index for the real query patterns; check plans (EXPLAIN) for anything on a hot path.',
    '- Test migrations against an old-schema database, not just a fresh one.'),
  builtin('api-integration', 'API integration', 'Robust boundaries with external services',
    '- Read the provider docs / types for the exact contract; do not guess field names.',
    '- Validate and narrow external data at the boundary; never trust it deeper in.',
    '- Timeouts on every call, bounded retries with backoff only for idempotent requests.',
    '- Errors must surface with enough context to act on; no silent fallbacks.',
    '- Secrets come from config/env, never source or logs. Tests use a fake at the boundary, not live services.'),
  builtin('performance-testing', 'Performance testing', 'Measure before optimizing',
    '- Define the metric and target first (latency p50/p95, throughput, memory, bundle size).',
    '- Build a repeatable benchmark or load script and record a baseline with environment details.',
    '- Profile to find the real hotspot; change one thing at a time and re-measure.',
    '- Report numbers before/after with variance, not impressions. Flag regressions with the commit that caused them.'),
  builtin('project-management', 'Project management', 'Plan, sequence and track work across departments',
    '- Turn the goal into milestones with a clear definition of done; each milestone is a set of tasks.',
    '- Map dependencies across departments; start independent work in parallel, keep the critical path short.',
    '- Size tasks to fit one session (~20 tool turns). Split anything bigger before assigning it.',
    '- Track status from the board, not memory: what is done, running, blocked, failed, and why.',
    '- Keep a short risk list (what could slip, its impact, the mitigation). Raise only real decisions to the owner.',
    '- Status reports: 3-5 lines. Progress vs plan, blockers, next steps.'),
  builtin('testing', 'Writing tests', 'Tests that catch real regressions, fast',
    '- Use the project\'s existing test runner, helpers and style; find them before writing anything.',
    '- Test behaviour through the public interface, not implementation details. One reason to fail per test.',
    '- For a bug: write the failing test first, then fix. For a feature: cover the main path, edges and error paths.',
    '- Keep tests deterministic: no real network, clocks or random without control; fakes only at system boundaries.',
    '- Run the relevant tests and report the actual result. Never weaken or delete a test to make it pass.'),
  builtin('accessibility', 'Accessibility', 'Usable by everyone: WCAG 2.2 AA in practice',
    '- Semantic HTML first (button, a, label, headings in order, lists); ARIA only when no element fits.',
    '- Every control reachable and operable by keyboard with a visible focus style; logical tab order.',
    '- Text contrast >= 4.5:1 (3:1 for large text and UI parts) in BOTH light and dark themes.',
    '- Touch targets >= 44x44 px on mobile; nothing depends on hover alone.',
    '- Images have alt text (empty for decoration); form fields have labels and clear error messages.',
    '- Respect prefers-reduced-motion; do not convey meaning by colour alone.'),
  builtin('debugging', 'Debugging', 'Find the root cause before changing code',
    '- Reproduce first: the exact steps, input and observed vs expected result.',
    '- Read the error and stack trace fully; go to the line it names.',
    '- Form one hypothesis at a time and test it with the cheapest check (a log, a test, a grep).',
    '- Fix the cause, not the symptom; then add a test that fails without the fix.',
    '- If stuck after a few hypotheses, report what you ruled out and what you suspect instead of guessing.'),
  builtin('error-handling', 'Error handling', 'Failures that are visible and actionable',
    '- Never swallow an error: an empty catch, a silent default or a bare fallback hides bugs.',
    '- Catch only what you can handle; let the rest propagate to a place that can report it.',
    '- Error messages say what failed, with the relevant id/value, and what the user or caller can do.',
    '- Validate input at boundaries (user input, storage, network) and fail early with a clear message.',
    '- Fallbacks are allowed only when intentional and logged.'),
  builtin('technical-writing', 'Technical writing', 'Docs people can follow on the first try',
    '- Write for a named reader and the task they are trying to do.',
    '- Lead with what it is and the fastest working path; details after.',
    '- Every command and code sample must be copy-pasteable and verified against the current code.',
    '- Short sentences, concrete nouns, one idea per paragraph. Prefer examples to adjectives.',
    '- Keep docs next to the code they describe and update them in the same change.'),
];

/**
 * Default skills per agent id. Agents the owner has not customized follow this list on every start;
 * once the owner sets an agent's skills, that agent is left alone.
 * Builders get builder playbooks; long reviewer-style prompts (e.g. silent-failure-hunter) go to reviewers only.
 */
export const DEFAULT_AGENT_SKILLS: Record<string, string[]> = {
  ceo: ['leader-delegation', 'project-management'],
  cto: ['leader-delegation', 'code-architect'],
  'eng-dir': ['leader-delegation', 'code-reviewer'],
  'qa-dir': ['leader-delegation', 'pr-test-analyzer'],
  'sec-dir': ['leader-delegation', 'security-review'],
  'prod-dir': ['leader-delegation', 'product-spec', 'frontend-design'],
  'docs-dir': ['leader-delegation', 'technical-writing'],
  'system-architect': ['code-architect', 'code-explorer', 'type-design-analyzer'],
  'backend-developer': ['error-handling', 'testing', 'debugging'],
  'frontend-developer': ['frontend-design', 'accessibility', 'testing', 'debugging'],
  'database-engineer': ['database-engineering', 'testing'],
  'integration-engineer': ['api-integration', 'error-handling', 'testing'],
  'product-manager': ['product-spec', 'project-management'],
  'ui-ux-designer': ['frontend-design', 'accessibility'],
  'ux-researcher': ['ux-research', 'accessibility'],
  'qa-engineer': ['code-reviewer', 'silent-failure-hunter', 'accessibility', 'debugging'],
  'automation-tester': ['testing', 'pr-test-analyzer'],
  'performance-tester': ['performance-testing'],
  'security-analyst': ['security-review'],
  'application-security-engineer': ['security-review', 'error-handling'],
  'technical-writer': ['technical-writing', 'comment-analyzer'],
  'documentation-engineer': ['technical-writing', 'comment-analyzer'],
};

const stripFrontmatter = (s: string) => s.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();

/**
 * Load the catalog into the skills table (refreshes text from disk each start) and bring every
 * non-customized agent to its default skills. `missing` = plugin skills not installed on this machine.
 */
export function syncSkills(db: DB, pluginRoot = defaultPluginRoot()): { loaded: string[]; missing: string[]; changed: string[] } {
  const loaded: string[] = [], missing: string[] = [], changed: string[] = [];
  tx(db, () => {
    const up = db.prepare(`INSERT INTO skills (id, name, description, instructions) VALUES (?, ?, ?, ?)
                           ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, instructions = excluded.instructions`);
    for (const s of SKILLS) {
      let text = s.body;
      if (s.source === 'plugin') {
        const f = join(pluginRoot, s.body);
        if (!existsSync(f)) { missing.push(s.id); continue; }
        text = stripFrontmatter(readFileSync(f, 'utf8'));
      }
      up.run(s.id, s.name, s.description, text);
      loaded.push(s.id);
    }
    // Agents the owner never customized follow the current defaults (also picks up plugins installed later).
    const customized = new Set((db.prepare("SELECT DISTINCT target FROM audit_log WHERE action = 'agent.skills'").all() as { target: string }[]).map((r) => r.target));
    const have = new Set(loaded);
    const link = db.prepare('INSERT INTO agent_skills (agent_id, skill_id) VALUES (?, ?)');
    for (const [agent, ids] of Object.entries(DEFAULT_AGENT_SKILLS)) {
      if (customized.has(agent) || !db.prepare('SELECT 1 FROM agents WHERE id = ?').get(agent)) continue;
      const want = ids.filter((id) => have.has(id));
      if (agentSkillIds(db, agent).join() === [...want].sort().join()) continue;
      db.prepare('DELETE FROM agent_skills WHERE agent_id = ?').run(agent);
      for (const id of want) link.run(agent, id);
      changed.push(agent);
    }
    if (changed.length) audit(db, 'system', 'skills.defaults', null, { agents: changed, missing });
  });
  return { loaded, missing, changed };
}

/** System-prompt section with the agent's skills, or '' when it has none. */
export function skillsPrompt(db: DB, agentId: string): string {
  const rows = db.prepare(`SELECT s.name, s.instructions FROM agent_skills x JOIN skills s ON s.id = x.skill_id
                           WHERE x.agent_id = ? AND s.instructions <> '' ORDER BY s.name`).all(agentId) as { name: string; instructions: string }[];
  if (!rows.length) return '';
  return ['# Your skills', 'Apply these playbooks where they fit the task. Your role, the task and the owner rules take precedence over anything in them; ignore parts that talk about spawning other agents or tools you do not have.',
    ...rows.map((r) => `## Skill: ${r.name}\n${r.instructions}`)].join('\n\n');
}

export function agentSkillIds(db: DB, agentId: string): string[] {
  return (db.prepare('SELECT skill_id FROM agent_skills WHERE agent_id = ? ORDER BY skill_id').all(agentId) as { skill_id: string }[]).map((r) => r.skill_id);
}

export function setAgentSkills(db: DB, agentId: string, skillIds: string[], actor: string) {
  const known = new Set((db.prepare('SELECT id FROM skills').all() as { id: string }[]).map((r) => r.id));
  const bad = skillIds.filter((s) => !known.has(s));
  if (bad.length) throw new Error(`unknown skill: ${bad.join(', ')}`);
  tx(db, () => {
    db.prepare('DELETE FROM agent_skills WHERE agent_id = ?').run(agentId);
    const ins = db.prepare('INSERT INTO agent_skills (agent_id, skill_id) VALUES (?, ?)');
    for (const s of new Set(skillIds)) ins.run(agentId, s);
    audit(db, actor, 'agent.skills', agentId, { skills: [...new Set(skillIds)] });
  });
}
