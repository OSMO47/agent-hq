import { Tile, Section, Empty, Meter } from '../ui';
import { ago, api } from '../api';
import { useState } from 'react';

const gb = (b: number) => (b / 1024 ** 3).toFixed(1);

function Window({ name, w }: { name: string; w?: { utilization: number; resetsAt: number; status: string } }) {
  if (!w) return null;
  const pct = Math.round(w.utilization * 100);
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-[12px]">
        <span className="text-dim">{name}</span>
        <span className="font-mono">{pct}%<span className="ml-2 text-faint">resets {new Date(w.resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span></span>
      </div>
      <Meter value={pct} tone={pct >= 90 ? 'bg-shu' : pct >= 70 ? 'bg-kin' : 'bg-matcha'} />
    </div>
  );
}

export default function Overview({ overview: o }: { overview: any }) {
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState('');
  const check = async () => { setChecking(true); setErr(''); try { await api('POST', '/api/owner/check-usage'); } catch (e) { setErr((e as Error).message); } setChecking(false); };
  if (!o) return <Empty>Loading…</Empty>;
  const t = o.tasks ?? {};
  const s = o.sessions ?? {};
  const memUsed = 100 - (o.system.freeMem / o.system.totalMem) * 100;
  const rl = o.claude.lastRateLimit;
  const windows = rl?.unifiedWindows ?? {};

  return (
    <div className="space-y-4 p-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Tile label="Agents" value={o.agents.total} sub={`${o.agents.active} active · ${o.agents.suspended} suspended`} />
        <Tile label="Working" value={o.agents.busy} tone={o.agents.busy ? 'text-matcha' : ''} sub="with a live session" />
        <Tile label="Idle" value={o.agents.idle} sub="ready for work" />
        <Tile label="Failed" value={o.agents.failedLast24h} tone={o.agents.failedLast24h ? 'text-shu' : ''} sub="agents · last 24h" />
        <Tile label="Running" value={(s.running ?? 0) + (s.starting ?? 0)} sub={`${s.queued ?? 0} queued`} />
        <Tile label="Done" value={t.DONE ?? 0} sub={`${t.REVIEW ?? 0} in review`} />
        <Tile label="Approvals" value={o.pendingApprovals} tone={o.pendingApprovals ? 'text-kin' : ''} sub="pending" />
        <Tile label="Recruitment" value={o.pendingRecruitment} sub="requests pending" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_1fr_1.4fr]">
        <Section title="Claude usage" right={<button className="btn h-6 text-[11px]" onClick={check} disabled={checking}>{checking ? 'Checking…' : '↻ Check now'}</button>}>
          <div className="space-y-4 p-4">
            {rl ? (
              <>
                <Window name="5-hour window" w={windows.five_hour} />
                <Window name="7-day window" w={windows.seven_day} />
                <div className="text-[11.5px] text-faint">Reported by Claude Code · updated {ago(o.claude.lastRateLimitAt)}. Refreshes on every run; ↻ Check now costs one tiny haiku turn.</div>
              </>
            ) : <div className="text-[12px] text-faint">No report yet. Claude Code reports usage only during a run: press ↻ Check now (one tiny haiku turn). Nothing is estimated.</div>}
            {err && <div className="text-[11.5px] text-shu">{err}</div>}
            <div className="flex items-baseline justify-between border-t border-line pt-3 text-[12px]">
              <span className="text-dim">API-equivalent estimate today</span>
              <span className="font-mono">{o.claude.costEstimateTodayUsd != null ? `$${o.claude.costEstimateTodayUsd.toFixed(2)}` : '—'}</span>
            </div>
            <div className="text-[11px] leading-relaxed text-faint">Estimate from the CLI, not a bill. Subscription plans are charged by plan, not per token.</div>
          </div>
        </Section>

        <Section title="This machine">
          <div className="space-y-4 p-4">
            <div className="space-y-1.5">
              <div className="flex justify-between text-[12px]"><span className="text-dim">CPU · {o.system.cpuCount} cores</span><span className="font-mono">{o.system.cpuPercent != null ? `${o.system.cpuPercent}%` : 'sampling…'}</span></div>
              <Meter value={o.system.cpuPercent ?? 0} tone="bg-ai" />
            </div>
            <div className="space-y-1.5">
              <div className="flex justify-between text-[12px]"><span className="text-dim">Memory</span><span className="font-mono">{gb(o.system.totalMem - o.system.freeMem)} / {gb(o.system.totalMem)} GB</span></div>
              <Meter value={memUsed} tone={memUsed > 90 ? 'bg-shu' : 'bg-ai'} />
            </div>
            <div className="flex justify-between text-[12px]"><span className="text-dim">GPU</span><span className="text-faint">not detected</span></div>
            <div className="truncate text-[11px] text-faint" title={o.system.cpuModel}>{o.system.cpuModel}</div>
          </div>
        </Section>

        <Section title="Recent activity" className="max-h-[340px]">
          <div className="h-full overflow-y-auto">
            {o.recentActivity.length === 0 ? <Empty>No activity yet.</Empty> : o.recentActivity.map((a: any) => (
              <div key={a.id} className="flex items-baseline gap-3 border-b border-line/60 px-4 py-2 text-[12px] last:border-0">
                <span className="w-14 shrink-0 font-mono text-[10.5px] text-faint">{ago(a.created_at)}</span>
                <span className="w-16 shrink-0 truncate text-dim">{a.actor}</span>
                <span className="font-mono text-[11.5px]">{a.action}</span>
                <span className="ml-auto truncate font-mono text-[10.5px] text-faint">{a.target}</span>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}
