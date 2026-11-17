import { Component, type ReactNode } from 'react';

const DOT: Record<string, string> = {
  running: 'bg-matcha', starting: 'bg-matcha', queued: 'bg-kin', completed: 'bg-ai', failed: 'bg-shu', timeout: 'bg-shu',
  stopped: 'bg-faint', interrupted: 'bg-kin', idle: 'bg-line-strong', suspended: 'bg-shu/50', inactive: 'bg-faint',
};
export function Dot({ status, pulse }: { status: string; pulse?: boolean }) {
  const live = pulse ?? (status === 'running' || status === 'starting');
  return <span className={`inline-block size-1.5 shrink-0 rounded-full ${DOT[status] ?? 'bg-faint'} ${live ? 'breathe' : ''}`} />;
}

const TASK_TONE: Record<string, string> = {
  BACKLOG: 'text-faint', PLANNED: 'text-dim', ASSIGNED: 'text-ai', RUNNING: 'text-matcha', REVIEW: 'text-kin',
  DONE: 'text-fg', BLOCKED: 'text-shu', FAILED: 'text-shu', CANCELLED: 'text-faint',
};
export const Status = ({ s }: { s: string }) => (
  <span className={`font-mono text-[10.5px] tracking-wider ${TASK_TONE[s] ?? DOT[s]?.replace('bg-', 'text-') ?? 'text-dim'}`}>{s}</span>
);

export function Tile({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="card rise px-4 py-3.5">
      <div className="label">{label}</div>
      <div className={`mt-2 font-mono text-[26px] leading-none tracking-tight ${tone ?? ''}`}>{value}</div>
      {sub != null && <div className="mt-2 text-[11.5px] text-dim">{sub}</div>}
    </div>
  );
}

export function Section({ title, right, children, className = '' }: { title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card rise flex min-h-0 flex-col ${className}`}>
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-line px-4">
        <span className="label">{title}</span>{right}
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onClick={onClose}>
      <aside className="rise flex h-full w-[520px] max-w-full flex-col border-l border-line bg-panel" onClick={(e) => e.stopPropagation()}>
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-5">
          <div className="min-w-0 truncate font-medium">{title}</div>
          <button className="btn" onClick={onClose} aria-label="Close">Esc</button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      </aside>
    </div>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => (
  <div className="flex h-full min-h-24 items-center justify-center px-6 py-8 text-center text-[12px] text-faint">{children}</div>
);

export const Kv = ({ k, children }: { k: string; children: ReactNode }) => (
  <div className="grid grid-cols-[110px_1fr] gap-3 border-b border-line/60 py-2 text-[12.5px] last:border-0">
    <span className="text-faint">{k}</span><span className="min-w-0 break-words">{children}</span>
  </div>
);

export const Meter = ({ value, tone = 'bg-fg' }: { value: number; tone?: string }) => (
  <div className="h-1 w-full overflow-hidden rounded-full bg-line">
    <div className={`h-full rounded-full ${tone} transition-[width] duration-500`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
  </div>
);

/** Contains a crash to one area and shows what broke, instead of blanking the whole app. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error('[hq] view crashed:', error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="m-5 rounded-lg border border-shu/40 p-4 text-[12px]">
        <div className="mb-1 text-shu">This view hit an error and was stopped.</div>
        <pre className="whitespace-pre-wrap text-faint">{String(this.state.error.message)}</pre>
        <button className="btn mt-3" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}
