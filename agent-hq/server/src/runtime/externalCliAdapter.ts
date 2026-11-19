import { spawn } from 'node:child_process';
import type { RuntimeAdapter, RunSpec, RunHandle, RuntimeEvent } from './types.ts';
import { JsonLineBuffer } from './streamParser.ts';
import { killTree } from './claudeCliAdapter.ts';
import { parseExternalModel, type ExternalCli } from './models.ts';

/** Session ids of non-Claude CLIs carry this prefix so they are never passed to `claude --resume`. */
export const EXT_ID = 'ext-';

export function buildCodexArgs(spec: RunSpec, id: string): string[] {
  // Prompt (with system prompt prepended) is read from stdin via "-".
  return ['exec', '--json', '--skip-git-repo-check', '-m', id, '-s', spec.permissionMode === 'plan' ? 'read-only' : 'workspace-write', '-C', spec.cwd, '-'];
}
export function buildGeminiArgs(spec: RunSpec, id: string): string[] {
  const a = ['-m', id, '--output-format', 'stream-json'];
  if (spec.permissionMode !== 'plan') a.push('--yolo'); // headless: no one to click "approve"
  return a;
}

/** Stateful parser: both CLIs emit JSON lines; map them to normalized events. Unknown shapes are ignored, never thrown. */
export class ExternalParser {
  private sid = ''; private text = ''; private inTok = 0; private outTok = 0; private turns = 0; private done = false;
  private readonly cli: ExternalCli;
  private readonly model: string;
  constructor(cli: ExternalCli, model: string) { this.cli = cli; this.model = model; }

  push(o: any): RuntimeEvent[] {
    const ev: RuntimeEvent[] = [];
    if (!o || typeof o !== 'object') return ev;
    if (this.cli === 'codex') {
      if (o.type === 'thread.started') { this.sid = EXT_ID + o.thread_id; ev.push({ kind: 'init', claudeSessionId: this.sid, model: this.model, tools: [] }); }
      else if (o.type === 'item.completed' && o.item) {
        const it = o.item;
        if (it.type === 'agent_message' && it.text) { this.text = it.text; ev.push({ kind: 'text', text: it.text }); }
        else if (it.type === 'command_execution') {
          ev.push({ kind: 'tool_use', id: it.id ?? '', name: 'shell', input: { command: it.command } });
          ev.push({ kind: 'tool_result', toolUseId: it.id ?? '', isError: (it.exit_code ?? 0) !== 0, content: String(it.aggregated_output ?? '') });
        }
      } else if (o.type === 'turn.completed') {
        this.turns++; this.inTok += o.usage?.input_tokens ?? 0; this.outTok += o.usage?.output_tokens ?? 0;
        ev.push(this.result(true, 'success'));
      } else if (o.type === 'turn.failed' || o.type === 'error') ev.push(this.result(false, 'error', o.error?.message ?? o.message));
    } else {
      if (o.type === 'init') { this.sid = EXT_ID + (o.session_id ?? Date.now()); ev.push({ kind: 'init', claudeSessionId: this.sid, model: o.model ?? this.model, tools: [] }); }
      else if (o.type === 'message' && o.role === 'assistant' && o.content) { this.text += String(o.content); ev.push({ kind: 'text', text: String(o.content) }); }
      else if (o.type === 'tool_use') ev.push({ kind: 'tool_use', id: o.tool_id ?? '', name: o.tool_name ?? 'tool', input: o.parameters });
      else if (o.type === 'tool_result') ev.push({ kind: 'tool_result', toolUseId: o.tool_id ?? '', isError: o.status === 'error', content: String(o.output ?? '') });
      else if (o.type === 'result') {
        this.turns = 1; this.inTok = o.stats?.input_tokens ?? 0; this.outTok = o.stats?.output_tokens ?? 0;
        ev.push(this.result(o.status !== 'error', o.status === 'error' ? 'error' : 'success'));
      }
    }
    return ev;
  }

  private result(ok: boolean, subtype: string, err?: string): RuntimeEvent {
    this.done = true;
    return { kind: 'result', ok, text: ok ? this.text : (err ?? this.text), claudeSessionId: this.sid, numTurns: this.turns, costUsdEstimate: null,
      inputTokens: this.inTok, outputTokens: this.outTok, permissionDenials: [], subtype };
  }
}

const KEEP_ENV = /^(OPENAI_|CODEX_|GEMINI_|GOOGLE_)/;
function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!/(_KEY|_TOKEN|SECRET|PASSWORD|CREDENTIAL)$/i.test(k) || KEEP_ENV.test(k)) out[k] = v;
  for (const k of Object.keys(out)) if (/^BUN_INSPECT/i.test(k)) delete out[k];
  if (out.NODE_OPTIONS && /--inspect/.test(out.NODE_OPTIONS)) delete out.NODE_OPTIONS;
  return out;
}

/** Runs `codex exec` / `gemini` headless, like the Claude CLI. Binaries: CODEX_BIN, GEMINI_BIN (default: on PATH). */
export class ExternalCliAdapter implements RuntimeAdapter {
  readonly name = 'external-cli';
  start(spec: RunSpec, onEvent: (e: RuntimeEvent) => void): RunHandle {
    const ext = parseExternalModel(spec.model);
    if (!ext) throw new Error(`not an external CLI model: ${spec.model}`);
    const bin = (ext.cli === 'codex' ? process.env.CODEX_BIN : process.env.GEMINI_BIN) || ext.cli;
    const args = ext.cli === 'codex' ? buildCodexArgs(spec, ext.id) : buildGeminiArgs(spec, ext.id);
    // npm-installed CLIs are .cmd shims on Windows and need a shell; args are validated/ours, prompt goes via stdin.
    const child = spawn(bin, args, { cwd: spec.cwd, env: childEnv(process.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      shell: process.platform === 'win32', detached: process.platform !== 'win32' });
    child.stdin.end(spec.systemPrompt ? `${spec.systemPrompt}\n\n${spec.prompt}` : spec.prompt);

    const parser = new ExternalParser(ext.cli, spec.model);
    const lines = new JsonLineBuffer();
    child.stdout.setEncoding('utf8').on('data', (c: string) =>
      lines.push(c, (o) => parser.push(o).forEach(onEvent), (bad) => onEvent({ kind: 'stderr', text: bad })));
    child.stderr.setEncoding('utf8').on('data', (c: string) => onEvent({ kind: 'stderr', text: c }));
    const done = new Promise<number | null>((resolve) => {
      child.on('error', (err) => { onEvent({ kind: 'stderr', text: `spawn error: ${err.message}` }); resolve(null); });
      child.on('close', (code) => resolve(code));
    });
    return { pid: child.pid, done, stop: () => { if (child.pid && child.exitCode === null) killTree(child.pid); } };
  }
}

/** Claude aliases → Claude CLI; "codex:" / "gemini:" → their CLIs. Conversation ids don't cross vendors. */
export class RoutingAdapter implements RuntimeAdapter {
  readonly name = 'router';
  private readonly claude: RuntimeAdapter;
  private readonly ext: RuntimeAdapter;
  constructor(claude: RuntimeAdapter, ext: RuntimeAdapter) { this.claude = claude; this.ext = ext; }
  start(spec: RunSpec, onEvent: (e: RuntimeEvent) => void): RunHandle {
    const external = !!parseExternalModel(spec.model);
    const foreignId = spec.resumeSessionId?.startsWith(EXT_ID);
    const s = external || foreignId ? { ...spec, resumeSessionId: undefined } : spec;
    return (external ? this.ext : this.claude).start(s, onEvent);
  }
}
