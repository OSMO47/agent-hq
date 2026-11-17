import { spawn, spawnSync } from 'node:child_process';
import type { RuntimeAdapter, RunSpec, RunHandle, RuntimeEvent } from './types.ts';
import { parseClaudeEvent, JsonLineBuffer } from './streamParser.ts';

const SECRET_ENV = /(_KEY|_TOKEN|SECRET|PASSWORD|CREDENTIAL)$/i;

/** Build argv for a headless run. Only documented `claude --help` flags are used. */
export function buildClaudeArgs(spec: RunSpec): string[] {
  const a = ['-p', '--output-format', 'stream-json', '--verbose', '--model', spec.model,
    // Do not inherit the user's claude.ai connectors (Gmail, Drive…) into agents.
    '--strict-mcp-config'];
  if (spec.resumeSessionId) a.push('--resume', spec.resumeSessionId);
  if (spec.systemPrompt) a.push('--append-system-prompt', spec.systemPrompt);
  if (spec.tools) a.push('--tools', spec.tools.join(','));
  if (spec.permissionMode) a.push('--permission-mode', spec.permissionMode);
  if (spec.allowedTools?.length) a.push('--allowedTools', spec.allowedTools.join(','));
  if (spec.disallowedTools?.length) a.push('--disallowedTools', spec.disallowedTools.join(','));
  for (const d of spec.addDirs ?? []) a.push('--add-dir', d);
  if (spec.maxTurns) a.push('--max-turns', String(spec.maxTurns));
  return a;
}

/** Child env without obvious secrets. Claude's own auth lives in its config dir, not env. */
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  // Keep Claude's own auth variables (ANTHROPIC_*, CLAUDE_*) so supported CLI auth keeps working.
  for (const [k, v] of Object.entries(env)) if (!SECRET_ENV.test(k) || /^(ANTHROPIC_|CLAUDE_)/.test(k)) out[k] = v;
  return out;
}

export function killTree(pid: number) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
}

export class ClaudeCliAdapter implements RuntimeAdapter {
  readonly name = 'claude-code-cli';
  private readonly bin: string;
  constructor(bin = process.env.CLAUDE_BIN || 'claude') { this.bin = bin; }

  start(spec: RunSpec, onEvent: (e: RuntimeEvent) => void): RunHandle {
    const child = spawn(this.bin, buildClaudeArgs(spec), {
      cwd: spec.cwd,
      env: scrubEnv(process.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    // Prompt goes via stdin: avoids Windows command-line length/quoting limits.
    child.stdin.end(spec.prompt);

    const lines = new JsonLineBuffer();
    child.stdout.setEncoding('utf8').on('data', (c: string) =>
      lines.push(c, (o) => parseClaudeEvent(o).forEach(onEvent), (bad) => onEvent({ kind: 'stderr', text: bad })));
    child.stderr.setEncoding('utf8').on('data', (c: string) => onEvent({ kind: 'stderr', text: c }));

    const done = new Promise<number | null>((resolve) => {
      child.on('error', (err) => { onEvent({ kind: 'stderr', text: `spawn error: ${err.message}` }); resolve(null); });
      child.on('close', (code) => resolve(code));
    });
    return { pid: child.pid, done, stop: () => { if (child.pid && child.exitCode === null) killTree(child.pid); } };
  }
}
