import type { RuntimeEvent } from './types.ts';

/** Map one stream-json object from `claude -p --output-format stream-json --verbose` to normalized events. */
export function parseClaudeEvent(o: any): RuntimeEvent[] {
  if (!o || typeof o !== 'object') return [];
  switch (o.type) {
    case 'system':
      if (o.subtype === 'init') {
        return [{ kind: 'init', claudeSessionId: o.session_id, model: o.model ?? '', tools: o.tools ?? [] }];
      }
      return [];
    case 'assistant': {
      const out: RuntimeEvent[] = [];
      for (const c of o.message?.content ?? []) {
        if (c.type === 'text' && c.text) out.push({ kind: 'text', text: c.text });
        else if (c.type === 'tool_use') out.push({ kind: 'tool_use', id: c.id, name: c.name, input: c.input });
      }
      return out;
    }
    case 'user': {
      const out: RuntimeEvent[] = [];
      for (const c of o.message?.content ?? []) {
        if (c.type === 'tool_result') {
          const content = typeof c.content === 'string' ? c.content
            : Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? '').join('') : '';
          out.push({ kind: 'tool_result', toolUseId: c.tool_use_id, isError: !!c.is_error, content: content.slice(0, 4000) });
        }
      }
      return out;
    }
    case 'rate_limit_event':
      return [{ kind: 'rate_limit', info: o.rate_limit_info }];
    case 'result':
      return [{
        kind: 'result',
        ok: o.subtype === 'success' && !o.is_error,
        subtype: o.subtype ?? 'unknown',
        text: o.result ?? '',
        claudeSessionId: o.session_id,
        numTurns: o.num_turns ?? 0,
        costUsdEstimate: typeof o.total_cost_usd === 'number' ? o.total_cost_usd : null,
        inputTokens: (o.usage?.input_tokens ?? 0) + (o.usage?.cache_creation_input_tokens ?? 0) + (o.usage?.cache_read_input_tokens ?? 0),
        outputTokens: o.usage?.output_tokens ?? 0,
        permissionDenials: (o.permission_denials ?? []).map((d: any) => ({ tool: d.tool_name, input: d.tool_input })),
      }];
    default:
      return [{ kind: 'unknown', raw: o }];
  }
}

/** Incremental line splitter for a stdout stream of JSON lines. */
export class JsonLineBuffer {
  private buf = '';
  push(chunk: string, onObject: (o: unknown) => void, onBadLine?: (line: string) => void) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      try { onObject(JSON.parse(line)); } catch { onBadLine?.(line); }
    }
  }
}
