import { useState, type ReactNode } from 'react';
import { Empty } from '../ui';
import { ago, api } from '../api';
import { SessionWall, type Layout } from '../Terminals';

const LAYOUT_KEY = 'hq.overview.layout';
const readLayout = (): Layout => { try { return localStorage.getItem(LAYOUT_KEY) === 'fit' ? 'fit' : 'grid'; } catch { return 'grid'; } };

/** One figure in the status strip. */
function Stat({ icon, n, label, tone, href }: { icon: string; n: number; label: string; tone: string; href?: string }) {
  const body = (
    <span className={`flex items-baseline gap-2 ${n ? '' : 'opacity-50'}`}>
      <span className={`${tone} ${icon === '●' && n ? 'breathe' : ''}`}>{icon}</span>
      <span className="font-mono text-[20px] leading-none tracking-tight">{n}</span>
      <span className="label !text-dim">{label}</span>
    </span>
  );
  return href ? <a href={href} className="py-1 transition-colors hover:bg-raise/60">{body}</a> : <div className="py-1">{body}</div>;
}

/** One gauge in the bottom bar. */
function Gauge({ label, pct, text, title, onClick }: { label: string; pct: number | null; text?: ReactNode; title?: string; onClick?: () => void }) {
  const tone = pct == null ? 'bg-line-strong' : pct >= 90 ? 'bg-shu' : pct >= 70 ? 'bg-kin' : 'bg-matcha';
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag title={title} onClick={onClick} className={`flex min-w-0 items-center gap-2.5 text-left ${onClick ? 'rounded px-1 hover:bg-raise' : 'px-1'}`}>
      <span className="label shrink-0">{label}</span>
      <span className="font-mono text-[12.5px]">{text ?? (pct == null ? '—' : `${Math.round(pct)}%`)}</span>
      {pct != null && (
        <span className="hidden h-1 w-14 overflow-hidden rounded-full bg-line sm:block">
          <span className={`block h-full rounded-full ${tone} transition-[width] duration-500`} style={{ width: `${Math.min(100, pct)}%` }} />
        </span>
      )}
    </Tag>
  );
}

export default function Overview({ overview: o }: { overview: any }) {
  const [layout, setLayoutState] = useState<Layout>(readLayout);
  const [checking, setChecking] = useState(false);
  const setLayout = (l: Layout) => { setLayoutState(l); try { localStorage.setItem(LAYOUT_KEY, l); } catch { /* private mode */ } };
  const check = async () => { setChecking(true); try { await api('POST', '/api/owner/check-usage'); } catch { /* shown via stale value */ } setChecking(false); };
  if (!o) return <Empty>Loading…</Empty>;

  const t = o.tasks ?? {};
  const s = o.sessions ?? {};
  const running = (s.running ?? 0) + (s.starting ?? 0);
  const attention = o.pendingApprovals + (t.FAILED ?? 0);
  const mem = 100 - (o.system.freeMem / o.system.totalMem) * 100;
  const five = o.claude.lastRateLimit?.unifiedWindows?.five_hour;
  const seven = o.claude.lastRateLimit?.unifiedWindows?.seven_day;
  const claudePct = five ? five.utilization * 100 : null;
  const resets = (w: any) => new Date(w.resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const claudeTitle = five
    ? `5-hour window ${Math.round(five.utilization * 100)}% · resets ${resets(five)}${seven ? `\n7-day window ${Math.round(seven.utilization * 100)}% · resets ${resets(seven)}` : ''}\nUpdated ${ago(o.claude.lastRateLimitAt)} · click to check now (one tiny haiku turn)`
    : 'No usage report yet · click to check now (one tiny haiku turn)';
  const last = o.recentActivity?.[0];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* status strip */}
      <div className="flex shrink-0 flex-wrap items-center gap-y-2 border-b border-line bg-panel px-4 py-2.5">
        <div className="flex flex-wrap items-center divide-x divide-line [&>*]:px-3">
          <Stat icon="●" n={o.agents.busy} label="Working" tone="text-matcha" href="#/sessions" />
          <Stat icon="◉" n={running} label="Running" tone="text-ai" href="#/sessions" />
          {(s.queued ?? 0) > 0 && <Stat icon="◌" n={s.queued} label="Queued" tone="text-kin" href="#/sessions" />}
          <Stat icon="✓" n={t.DONE ?? 0} label="Done" tone="text-matcha" href="#/tasks" />
          <Stat icon="⚠" n={attention} label="Needs attention" tone="text-accent" href="#/tasks" />
        </div>
        <span className="ml-auto flex items-center gap-3 px-1 text-[11px] text-faint">
          {o.paused ? <span className="text-shu">■ paused</span> : <span>{o.autoPilot ? 'autopilot on' : 'autopilot off'}</span>}
          <span>{o.agents.active} agents</span>
        </span>
      </div>

      {/* session wall */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-ink px-5 py-4">
        <SessionWall layout={layout} setLayout={setLayout} />
      </div>

      {/* machine + usage bar */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2 border-t border-line bg-panel px-5 py-2.5">
        <Gauge label="CPU" pct={o.system.cpuPercent ?? null} title={`${o.system.cpuModel} · ${o.system.cpuCount} cores`} />
        <Gauge label="RAM" pct={mem} title={`${((o.system.totalMem - o.system.freeMem) / 1024 ** 3).toFixed(1)} / ${(o.system.totalMem / 1024 ** 3).toFixed(1)} GB`} />
        <Gauge label="Claude" pct={claudePct} text={checking ? 'checking…' : undefined} title={claudeTitle} onClick={checking ? undefined : check} />
        <Gauge label="Today" pct={null} text={o.claude.costEstimateTodayUsd != null ? `$${o.claude.costEstimateTodayUsd.toFixed(2)}` : '—'} title="API-equivalent estimate from the CLI, not a bill" />
        <div className="ml-auto flex min-w-0 items-center gap-2.5 px-1 text-[12px]" title={last ? `${last.actor} · ${last.action} ${last.target ?? ''}` : ''}>
          <span className="label shrink-0">Last event</span>
          <span className="font-mono">{last ? ago(last.created_at) : '—'}</span>
          {last && <span className="hidden truncate text-[11px] text-faint lg:inline">{last.action}</span>}
        </div>
      </div>
    </div>
  );
}
