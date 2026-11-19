import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExternalParser, RoutingAdapter, buildCodexArgs, buildGeminiArgs } from '../src/runtime/externalCliAdapter.ts';
import { isKnownModel } from '../src/runtime/models.ts';
import type { RuntimeAdapter } from '../src/runtime/types.ts';

test('model validation: claude aliases plus codex:/gemini: ids only', () => {
  for (const m of ['opus', 'codex:gpt-5', 'gemini:gemini-2.5-pro']) assert.ok(isKnownModel(m), m);
  for (const m of ['gpt-4', 'codex:', 'openai:gpt-4o', 'gemini:a b', 'codex:x;rm', 5]) assert.ok(!isKnownModel(m), String(m));
});

test('codex JSONL maps to init/text/tool/result', () => {
  const p = new ExternalParser('codex', 'codex:gpt-5');
  const ev = [
    { type: 'thread.started', thread_id: 'T1' },
    { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'ls', exit_code: 0, aggregated_output: 'a' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
    { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } },
  ].flatMap((o) => p.push(o));
  assert.deepEqual(ev.map((e) => e.kind), ['init', 'tool_use', 'tool_result', 'text', 'result']);
  const r: any = ev.at(-1);
  assert.deepEqual([r.ok, r.text, r.claudeSessionId, r.inputTokens], [true, 'done', 'ext-T1', 5]);
});

test('gemini stream-json maps to init/text/result; errors fail the result', () => {
  const p = new ExternalParser('gemini', 'gemini:gemini-2.5-pro');
  const ev = [
    { type: 'init', session_id: 'S1', model: 'gemini-2.5-pro' },
    { type: 'message', role: 'user', content: 'ignored' },
    { type: 'message', role: 'assistant', content: 'hel' }, { type: 'message', role: 'assistant', content: 'lo' },
    { type: 'result', status: 'success', stats: { input_tokens: 4, output_tokens: 1 } },
  ].flatMap((o) => p.push(o));
  assert.deepEqual(ev.map((e) => e.kind), ['init', 'text', 'text', 'result']);
  assert.equal((ev.at(-1) as any).text, 'hello');
  assert.equal((new ExternalParser('gemini', 'm').push({ type: 'result', status: 'error' })[0] as any).ok, false);
  assert.deepEqual(new ExternalParser('codex', 'm').push('junk'), []);
});

test('argv: prompt never on the command line; plan mode is read-only', () => {
  const s: any = { prompt: 'secret prompt', cwd: 'C:/x', model: 'codex:gpt-5' };
  assert.ok(!buildCodexArgs(s, 'gpt-5').join(' ').includes('secret'));
  assert.ok(buildCodexArgs({ ...s, permissionMode: 'plan' }, 'gpt-5').includes('read-only'));
  assert.ok(buildGeminiArgs(s, 'g').includes('--yolo'));
  assert.ok(!buildGeminiArgs({ ...s, permissionMode: 'plan' }, 'g').includes('--yolo'));
});

test('router: claude aliases to claude, codex/gemini to ext; resume ids never cross vendors', () => {
  const seen: string[] = [];
  const mk = (n: string): RuntimeAdapter => ({ name: n, start: (s) => { seen.push(`${n}:${s.resumeSessionId ?? '-'}`); return { pid: 1, done: Promise.resolve(0), stop() {} }; } });
  const r = new RoutingAdapter(mk('claude'), mk('ext'));
  const b: any = { prompt: '', cwd: '.' };
  r.start({ ...b, model: 'opus', resumeSessionId: 'ext-1' }, () => {});
  r.start({ ...b, model: 'opus', resumeSessionId: 'c-1' }, () => {});
  r.start({ ...b, model: 'codex:gpt-5', resumeSessionId: 'c-1' }, () => {});
  assert.deepEqual(seen, ['claude:-', 'claude:c-1', 'ext:-']);
});
