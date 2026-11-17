import { useEffect, useState } from 'react';
import { useResource } from '../api';
import { Empty, Dot } from '../ui';
import { Transcript, Composer, LIVE } from '../Transcript';

/** One agent's workspace: its sessions as tabs, the selected one as a conversation. */
export default function Agent({ param }: { param?: string }) {
  const org = useResource<{ agents: any[] }>('/api/org', ['org', 'session.status']);
  const list = useResource<any[]>('/api/sessions', ['session.status']);
  const agent = org.data?.agents.find((a) => a.id === param);
  const sessions = (list.data ?? []).filter((s) => s.agent_id === param).slice(0, 12);
  const [tab, setTab] = useState<string | null>(null);
  useEffect(() => { setTab(null); }, [param]);
  const sel = sessions.find((s) => s.id === tab)?.id ?? tab ?? sessions[0]?.id ?? null;

  if (!org.data || !list.data) return <Empty>Loading…</Empty>;
  if (!agent) return <Empty>Agent not found.</Empty>;
  const label = (s: any) => s.task_title ?? (s.purpose === 'plan' ? 'Planning' : s.purpose === 'assess' ? 'Difficulty rating' : 'Follow-up');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-end overflow-x-auto border-b border-line px-2">
        {sessions.map((s) => (
          <button key={s.id} onClick={() => setTab(s.id)} title={label(s)}
            className={`flex h-9 max-w-[220px] shrink-0 items-center gap-2 rounded-t-lg border border-b-0 px-3 text-[11.5px] transition-colors ${s.id === sel ? 'border-line-strong bg-panel text-fg' : 'border-transparent text-dim hover:text-fg'}`}>
            {LIVE.includes(s.status) && <Dot status={s.status} />}
            {s.status === 'failed' && <span className="size-1.5 rounded-full bg-shu" />}
            <span className="truncate">{label(s)}</span>
          </button>
        ))}
      </div>
      {sel ? <Transcript key={sel} id={sel} agentName={agent.name} onNewSession={(sid) => { setTab(sid); list.reload(); }} />
        : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-1 items-center justify-center p-8">
              <div className="max-w-sm space-y-2 text-center">
                <div className="text-[13px]">{agent.name} has no conversations yet.</div>
                <div className="text-[11.5px] leading-relaxed text-faint">
                  Agents start working when a task assigned to them runs. {agent.id === 'ceo' ? 'Brief the CEO from the Task board to get a plan.' : 'Assign one from the Task board.'}
                </div>
                <a className="btn btn-primary mt-2" href="#/tasks">Open task board</a>
              </div>
            </div>
            <Composer disabled placeholder={`Talking to ${agent.name}: start a task first`} onSend={async () => {}} />
          </div>
        )}
    </div>
  );
}
