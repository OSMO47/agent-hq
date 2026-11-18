import { Bot, SquareTerminal } from 'lucide-react';
// Per-icon entry points: pure SVG components, no @lobehub/ui runtime pulled in.
import ClaudeColor from '@lobehub/icons/es/Claude/components/Color.js';
import OpenAIMono from '@lobehub/icons/es/OpenAI/components/Mono.js';
import GeminiColor from '@lobehub/icons/es/Gemini/components/Color.js';

export type AgentKind = 'claude' | 'codex' | 'gemini' | 'terminal' | (string & {});

/** Brand ring per vendor; tokens where a project colour fits, brand hex where it must be recognisable. */
const RING: Record<string, string> = {
  claude: 'ring-[#D97757]/45',
  codex: 'ring-fg/30',
  gemini: 'ring-[#4796E3]/45',
  terminal: 'ring-matcha/40',
};

/** Which runtime a session runs on. OSMO AGENT only runs Claude Code today; other kinds are ready for later adapters. */
export function AgentIcon({ kind, size = 24, title }: { kind: AgentKind; size?: number; title?: string }) {
  const glyph = Math.round(size * 0.6);
  const icon = kind === 'claude' ? <ClaudeColor size={glyph} />
    : kind === 'codex' ? <OpenAIMono size={glyph} className="text-fg" />
    : kind === 'gemini' ? <GeminiColor size={glyph} />
    : kind === 'terminal' ? <SquareTerminal size={glyph} className="text-matcha" strokeWidth={1.75} />
    : <Bot size={glyph} className="text-dim" strokeWidth={1.75} />;
  return (
    <span title={title ?? String(kind)} aria-label={title ?? String(kind)} role="img"
      className={`inline-flex shrink-0 items-center justify-center rounded-md bg-ink ring-1 ${RING[kind] ?? 'ring-line-strong'}`}
      style={{ width: size, height: size }}>
      {icon}
    </span>
  );
}
