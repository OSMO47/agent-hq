import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setPolicy } from '../src/db.ts';
import { seed } from '../src/seed.ts';
import { SessionManager } from '../src/runtime/sessionManager.ts';
import { parseClaudeEvent, JsonLineBuffer } from '../src/runtime/streamParser.ts';
import { buildClaudeArgs, scrubEnv } from '../src/runtime/claudeCliAdapter.ts';
import { ScriptedAdapter, tick } from './helpers.ts';

const spec = (prompt: string) => ({ prompt, cwd: '.', model: 'haiku' });
const result = (ok = true) => ({ kind: 'result' as const, ok, subtype: ok ? 'success' : 'error_max_turns', text: 'done', claudeSessionId: 'c1',
  numTurns: 1, costUsdEstimate: 0.001, inputTokens: 10, outputTokens: 2, permissionDenials: [] });

function setup(max = 2) {
  const db = openDb(':memory:');
  seed(db);
  setPolicy(db, 'runtime.maxConcurrentSessions', max, 'test');
  const ad = new ScriptedAdapter();
  return { db, ad, sm: new SessionManager(db, ad) };
}

test('parser maps real stream-json lines (captured from claude 2.1.326)', () => {
  const init = parseClaudeEvent({ type: 'system', subtype: 'init', session_id: 'abc', model: 'claude-haiku-5-5', tools: [] });
  assert.deepEqual(init, [{ kind: 'init', claudeSessionId: 'abc', model: 'claude-haiku-5-5', tools: [] }]);
  const asst = parseClaudeEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a' } }] } });
  assert.equal(asst.length, 2);
  const res = parseClaudeEvent({ type: 'result', subtype: 'success', is_error: false, result: 'OK', session_id: 'abc', num_turns: 1,
    total_cost_usd: 0.0006, usage: { input_tokens: 2, cache_creation_input_tokens: 3148, cache_read_input_tokens: 649, output_tokens: 4 },
    permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }] });
  assert.equal((res[0] as any).inputTokens, 3799);
  assert.deepEqual((res[0] as any).permissionDenials, [{ tool: 'Bash', input: { command: 'rm -rf x' } }]);
});

test('JsonLineBuffer handles split chunks and bad lines', () => {
  const b = new JsonLineBuffer(); const got: unknown[] = []; const bad: string[] = [];
  b.push('{"a":1}\n{"b"', (o) => got.push(o), (l) => bad.push(l));
  b.push(':2}\nnot json\n', (o) => got.push(o), (l) => bad.push(l));
  assert.deepEqual(got, [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(bad, ['not json']);
});

test('args use only documented flags and isolate MCP', () => {
  const a = buildClaudeArgs({ ...spec('x'), resumeSessionId: 'r1', allowedTools: ['Read', 'Edit'], permissionMode: 'default', addDirs: ['D:/w'], maxTurns: 5 });
  assert.ok(a.includes('--strict-mcp-config'));
  assert.deepEqual(a.slice(a.indexOf('--resume'), a.indexOf('--resume') + 2), ['--resume', 'r1']);
  assert.ok(!a.includes('x'), 'prompt must go via stdin, not argv');
  assert.ok(!a.some((x) => x.includes('dangerously')));
  const none = buildClaudeArgs({ ...spec('x'), tools: [] });
  assert.equal(none[none.indexOf('--tools') + 1], '', 'empty tools list => --tools ""');
});

test('scrubEnv removes foreign secrets but keeps Claude auth', () => {
  const e = scrubEnv({ PATH: 'p', GITHUB_TOKEN: 's', AWS_SECRET: 's', CLAUDE_CODE_OAUTH_TOKEN: 'k', ANTHROPIC_API_KEY: 'k' });
  assert.deepEqual(Object.keys(e).sort(), ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'PATH']);
});

test('scrubEnv drops inherited debugger hooks (agents failed with inspector EADDRINUSE)', () => {
  const e = scrubEnv({ PATH: 'p', BUN_INSPECT: 'ws://127.0.0.1:9238/', BUN_INSPECT_CONNECT_TO: 'x', NODE_OPTIONS: '--inspect=9229' });
  assert.deepEqual(Object.keys(e), ['PATH']);
  assert.equal(scrubEnv({ NODE_OPTIONS: '--max-old-space-size=4096' }).NODE_OPTIONS, '--max-old-space-size=4096');
});

test('concurrency limit queues extra sessions and pumps on completion', async () => {
  const { sm, ad } = setup(2);
  const ids = ['a', 'b', 'c'].map((p) => sm.enqueue({ agentId: 'ceo', spec: spec(p), actor: 'owner' }));
  assert.equal(ad.runs.length, 2);
  assert.equal(sm.get(ids[2])!.status, 'queued');

  ad.runs[0].emit({ kind: 'init', claudeSessionId: 'c1', model: 'm', tools: [] });
  assert.equal(sm.get(ids[0])!.status, 'running');
  ad.runs[0].emit(result());
  ad.runs[0].exit(0);
  await tick();
  assert.equal(sm.get(ids[0])!.status, 'completed');
  assert.equal(sm.get(ids[0])!.claude_session_id, 'c1');
  assert.equal(ad.runs.length, 3, 'third session started after a slot freed');
});

test('failed result or non-zero exit => failed', async () => {
  const { sm, ad } = setup(2);
  const a = sm.enqueue({ agentId: 'ceo', spec: spec('a'), actor: 'owner' });
  const b = sm.enqueue({ agentId: 'ceo', spec: spec('b'), actor: 'owner' });
  ad.runs[0].emit(result(false)); ad.runs[0].exit(0);
  ad.runs[1].exit(1);
  await tick();
  assert.equal(sm.get(a)!.status, 'failed');
  assert.equal(sm.get(b)!.status, 'failed');
});

test('stopAll kills live and cancels queued; pause blocks new starts', async () => {
  const { sm, ad, db } = setup(1);
  const a = sm.enqueue({ agentId: 'ceo', spec: spec('a'), actor: 'owner' });
  const b = sm.enqueue({ agentId: 'ceo', spec: spec('b'), actor: 'owner' });
  setPolicy(db, 'org.paused', true, 'owner');
  assert.equal(sm.stopAll('owner'), 2);
  await tick();
  assert.ok(ad.runs[0].stopped);
  assert.equal(sm.get(a)!.status, 'stopped');
  assert.equal(sm.get(b)!.status, 'stopped');
  sm.enqueue({ agentId: 'ceo', spec: spec('c'), actor: 'owner' });
  assert.equal(ad.runs.length, 1, 'paused org starts nothing');
});

test('restart marks running sessions interrupted but keeps queue', async () => {
  const { sm, db } = setup(1);
  const a = sm.enqueue({ agentId: 'ceo', spec: spec('a'), actor: 'owner' });
  const b = sm.enqueue({ agentId: 'ceo', spec: spec('b'), actor: 'owner' });
  const ad2 = new ScriptedAdapter();
  const sm2 = new SessionManager(db, ad2); // simulated server restart
  assert.equal(sm2.get(a)!.status, 'interrupted');
  sm2.pump();
  assert.equal(ad2.runs[0].spec.prompt, 'b');
  assert.equal(sm2.get(b)!.status, 'starting');
});

test('usage limit: session is requeued with --resume and nothing starts until reset', async () => {
  const { sm, ad } = setup(2);
  const a = sm.enqueue({ agentId: 'ceo', spec: spec('build it'), actor: 'owner' });
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  ad.runs[0].emit({ kind: 'init', claudeSessionId: 'conv-1', model: 'opus', tools: [] });
  ad.runs[0].emit({ kind: 'rate_limit', info: { status: 'rejected', resetsAt } });
  ad.runs[0].emit({ ...result(false), claudeSessionId: 'conv-1', text: "You've hit your usage limit" });
  ad.runs[0].exit(1);
  await tick();
  const row = sm.get(a)!;
  assert.equal(row.status, 'queued', 'not failed - waits for the reset');
  assert.equal(sm.rateLimitedUntil, resetsAt * 1000);
  sm.enqueue({ agentId: 'ceo', spec: spec('other'), actor: 'owner' });
  assert.equal(ad.runs.length, 1, 'no new starts while limited');

  sm.rateLimitedUntil = Date.now() - 1; // simulate the reset time passing
  sm.pump();
  assert.equal(ad.runs[1].spec.resumeSessionId, 'conv-1', 'resumes the same Claude conversation');
  assert.equal(ad.runs[1].spec.model, 'haiku', 'model is never downgraded or changed');
});

test('usage warning (allowed_warning) is not a limit: the queue keeps moving', async () => {
  const { sm, ad } = setup(1);
  sm.enqueue({ agentId: 'ceo', spec: spec('first'), actor: 'owner' });
  const resetsAt = Math.floor(Date.now() / 1000) + 5 * 86400; // weekly window, days away
  ad.runs[0].emit({ kind: 'rate_limit', info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.57, resetsAt } });
  ad.runs[0].emit(result(true));
  ad.runs[0].exit(0);
  await tick();
  assert.equal(sm.rateLimitedUntil, 0, 'a warning must not freeze the org until the weekly reset');
  sm.enqueue({ agentId: 'ceo', spec: spec('next'), actor: 'owner' });
  assert.equal(ad.runs.length, 2, 'next session starts right away');
});

test('owner policy: every seeded agent runs on opus', () => {
  const { db } = setup();
  assert.deepEqual(db.prepare("SELECT DISTINCT model FROM agents").all().map((r: any) => r.model), ['opus']);
});

test('usage probe: one tool-less haiku turn; report persists across restart', async () => {
  const { db, ad, sm } = setup();
  const info = { status: 'allowed', resetsAt: 1, unifiedWindows: { five_hour: { utilization: 0.11, resetsAt: 1, status: 'allowed' } } };
  const p = sm.probeUsage('.');
  assert.equal(sm.probeUsage('.'), p, 'concurrent probes share one run');
  const run = ad.runs[0];
  assert.equal(run.spec.model, 'haiku');
  assert.deepEqual(run.spec.tools, []);
  run.emit({ kind: 'rate_limit', info });
  run.exit(0);
  assert.deepEqual(await p, info);
  const sm2 = new SessionManager(db, new ScriptedAdapter()); // simulated restart
  assert.deepEqual(sm2.lastRateLimit, info);
  assert.ok(sm2.lastRateLimitAt);
});

test('local-only rule: every agent spec hard-denies deploy/push and says so', async () => {
  const { buildSpec, PUBLISH_DENY } = await import('../src/domain/taskRunner.ts');
  const { db } = setup();
  for (const a of db.prepare('SELECT * FROM agents').all() as any[]) {
    const s = buildSpec(a, 'x', '.', 5);
    for (const d of PUBLISH_DENY) assert.ok(s.disallowedTools!.includes(d), `${a.id} must deny ${d}`);
    assert.match(s.systemPrompt!, /Never deploy/);
    assert.ok(!buildClaudeArgs(s).includes('--dangerously-skip-permissions'));
  }
});
