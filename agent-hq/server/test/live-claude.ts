// Live smoke test: ONE real `claude -p` run (haiku, 1 turn) through SessionManager + ClaudeCliAdapter.
// Uses real quota — run manually: npm run test:live
import { openDb } from '../src/db.ts';
import { seed } from '../src/seed.ts';
import { SessionManager } from '../src/runtime/sessionManager.ts';
import { ClaudeCliAdapter } from '../src/runtime/claudeCliAdapter.ts';
import { tmpdir } from 'node:os';

const db = openDb(':memory:');
seed(db);
const sm = new SessionManager(db, new ClaudeCliAdapter());
sm.on('event', (_id, e) => console.log('event', e.kind, e.kind === 'text' ? JSON.stringify(e.text) : ''));
const id = sm.enqueue({
  agentId: 'technical-writer', actor: 'live-test',
  spec: { prompt: 'Reply with exactly the word: READY', cwd: tmpdir(), model: 'haiku', maxTurns: 1, tools: [], permissionMode: 'default' },
});
const deadline = Date.now() + 90_000;
while (!['completed', 'failed', 'stopped', 'timeout'].includes(sm.get(id)!.status)) {
  if (Date.now() > deadline) { sm.stopAll('live-test'); break; }
  await new Promise((r) => setTimeout(r, 250));
}
const s = sm.get(id)!;
console.log({ status: s.status, result: s.result_text, claudeSession: s.claude_session_id, tokensIn: s.input_tokens, tokensOut: s.output_tokens, costEstimate: s.cost_usd_estimate });
process.exit(s.status === 'completed' && /READY/.test(s.result_text ?? '') ? 0 : 1);
