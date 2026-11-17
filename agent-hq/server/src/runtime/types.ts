/** Normalized events emitted by any runtime adapter. Orchestration/UI never see raw CLI output. */
export type RuntimeEvent =
  | { kind: 'init'; claudeSessionId: string; model: string; tools: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; isError: boolean; content: string }
  | { kind: 'rate_limit'; info: unknown }
  | {
      kind: 'result'; ok: boolean; text: string; claudeSessionId: string; numTurns: number;
      costUsdEstimate: number | null; inputTokens: number; outputTokens: number;
      permissionDenials: { tool: string; input: unknown }[]; subtype: string;
    }
  | { kind: 'stderr'; text: string }
  | { kind: 'unknown'; raw: unknown };

export interface RunSpec {
  prompt: string;
  cwd: string;
  model: string;
  systemPrompt?: string;
  resumeSessionId?: string;     // follow-up / recovery: --resume
  /** Built-in tools loaded into context (--tools). [] = none. Fewer tools = far fewer input tokens. */
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: 'default' | 'plan' | 'acceptEdits';
  addDirs?: string[];
  maxTurns?: number;
}

export interface RunHandle {
  pid: number | undefined;
  /** Resolves with exit code when the process ends (never rejects). */
  done: Promise<number | null>;
  stop(): void;
}

export interface RuntimeAdapter {
  readonly name: string;
  start(spec: RunSpec, onEvent: (e: RuntimeEvent) => void): RunHandle;
}
