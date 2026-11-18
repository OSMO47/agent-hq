import { useState, type ReactNode } from 'react';

/** Soft fallback colours (token-based, so every theme stays consistent). */
const TINTS = ['bg-accent/15 text-accent', 'bg-ai/15 text-ai', 'bg-matcha/15 text-matcha', 'bg-kin/15 text-kin', 'bg-shu/15 text-shu'];
const tint = (id: string) => TINTS[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TINTS.length];

/**
 * Agent picture: the owner's image when one exists (`avatar` = its version), otherwise the name's first letter.
 * `badge` sits on the bottom-right corner (e.g. the runtime icon).
 */
export function Avatar({ agent, size = 28, badge, className = '' }:
  { agent: { id: string; name: string; avatar?: number | null }; size?: number; badge?: ReactNode; className?: string }) {
  const [broken, setBroken] = useState<number | null>(null);
  const showImg = agent.avatar != null && broken !== agent.avatar;
  return (
    <span className={`relative inline-flex shrink-0 ${className}`} style={{ width: size, height: size }}>
      {showImg ? (
        <img src={`/api/agents/${encodeURIComponent(agent.id)}/avatar?v=${agent.avatar}`} alt={agent.name} width={size} height={size}
          loading="lazy" draggable={false} onError={() => setBroken(agent.avatar ?? null)}
          className="size-full rounded-full bg-raise object-cover ring-1 ring-line-strong" />
      ) : (
        <span aria-label={agent.name} role="img"
          className={`flex size-full items-center justify-center rounded-full font-bold ring-1 ring-line ${tint(agent.id)}`}
          style={{ fontSize: Math.round(size * 0.42) }}>
          {agent.name.trim().charAt(0).toUpperCase()}
        </span>
      )}
      {badge && <span className="absolute -bottom-1 -right-1 rounded-md bg-panel p-px">{badge}</span>}
    </span>
  );
}
