import { useState } from 'react';
import { api, useResource, ago } from './api';
import { Empty } from './ui';
import { Markdown } from './Markdown';

/**
 * Owner inbox: the only things that need a human while autopilot runs the organization.
 *  decision   → an agent flagged NEEDS_OWNER (or hit a blocked tool): Approve, or reply and send back
 *  failed     → Retry or Cancel
 *  unassigned → the CEO could not pick anyone: choose
 */
export function InboxTab({ agents }: { agents: any[] }) {
  const { data, reload } = useResource<any[]>('/api/inbox', ['task', 'session.status', 'paused']);
  if (!data) return <Empty>Loading…</Empty>;
  if (data.length === 0) return (
    <Empty><div className="space-y-1"><div className="text-[18px] text-matcha">✓</div><div>Nothing needs you.</div><div>The team assigns, runs and approves routine work by itself.</div></div></Empty>
  );
  return <div className="space-y-3 p-3">{data.map((it) => <Item key={`${it.kind}:${it.task.id}`} it={it} agents={agents} onDone={reload} />)}</div>;
}

const KIND = { decision: ['Needs your decision', 'text-accent border-accent/40'], failed: ['Failed', 'text-shu border-shu/40'], unassigned: ['Needs an owner', 'text-kin border-kin/40'] } as const;

function Item({ it, agents, onDone }: { it: any; agents: any[]; onDone: () => void }) {
  const [reply, setReply] = useState(''); const [open, setOpen] = useState(false); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const t = it.task;
  const who = agents.find((a) => a.id === t.assignee_id);
  const [label, tone] = KIND[it.kind as keyof typeof KIND];
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(''); try { await fn(); onDone(); } catch (e) { setErr((e as Error).message); } setBusy(false); };
  const move = (to: string, note?: string) => act(() => api('POST', `/api/tasks/${t.id}/transition`, { to, note }));

  return (
    <div className={`rise rounded-lg border bg-ink/40 p-3 ${tone.split(' ')[1]}`}>
      <div className="flex items-center gap-2 text-[10.5px]">
        <span className={`font-bold uppercase tracking-wider ${tone.split(' ')[0]}`}>{label}</span>
        <span className="ml-auto text-faint">{ago(t.updated_at)}</span>
      </div>
      <a href={`#/tasks/${t.id}`} className="mt-1 block text-[12.5px] leading-snug hover:underline">{t.title}</a>
      {who && <div className="mt-0.5 text-[10.5px] text-faint">∿ {who.name}{who.name !== who.role ? ` · ${who.role}` : ''}</div>}

      {it.question && <div className="mt-2 whitespace-pre-wrap rounded-md border border-accent/30 bg-accent/[.06] px-2.5 py-2 text-[12px]">{it.question}</div>}
      {it.report && (
        <div className="mt-2">
          <button className="text-[11px] text-ai hover:underline" onClick={() => setOpen(!open)}>{open ? '⌃ hide report' : '⌄ agent report'}</button>
          {open && <div className="mt-1 max-h-72 overflow-y-auto rounded-md border border-line p-2.5"><Markdown text={it.report} /></div>}
        </div>
      )}

      {it.kind === 'decision' && (
        <div className="mt-3 space-y-2">
          <textarea className="field text-[12px]" rows={2} placeholder="Optional: your answer or changes (sent back to the agent)" value={reply} onChange={(e) => setReply(e.target.value)} />
          <div className="flex gap-2">
            <button className="btn btn-primary flex-1" disabled={busy} onClick={() => move('DONE')}>✓ Approve</button>
            <button className="btn flex-1" disabled={busy || !reply.trim()} onClick={() => move('ASSIGNED', reply.trim())} title="Send your answer back; the agent continues automatically">↩ Send back</button>
          </div>
        </div>
      )}
      {it.kind === 'failed' && (
        <div className="mt-3 flex gap-2">
          <button className="btn flex-1" disabled={busy} onClick={() => move('ASSIGNED', 'Retry after failure')}>↻ Retry</button>
          <button className="btn btn-danger flex-1" disabled={busy} onClick={() => move('CANCELLED')}>Cancel task</button>
        </div>
      )}
      {it.kind === 'unassigned' && (
        <select className="field mt-3" defaultValue="" disabled={busy}
          onChange={(e) => e.target.value && act(() => api('PATCH', `/api/tasks/${t.id}`, { assigneeId: e.target.value }))}>
          <option value="">Choose who does it…</option>
          {agents.filter((a) => a.level > 1 && a.status === 'active').map((a) => <option key={a.id} value={a.id}>{a.name === a.role ? a.role : `${a.name} · ${a.role}`}</option>)}
        </select>
      )}
      {err && <div className="mt-2 text-[11.5px] text-shu">{err}</div>}
    </div>
  );
}
