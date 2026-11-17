import { useResource, ago } from '../api';
import { Dot, Empty, Status } from '../ui';
import { Transcript } from '../Transcript';

/** Every session across the organization, newest first, with the selected one as a conversation. */
export default function Sessions({ param }: { param?: string }) {
  const list = useResource<any[]>('/api/sessions', ['session.status']);
  const sel = param ?? list.data?.[0]?.id ?? null;
  const cur = list.data?.find((s) => s.id === sel);

  return (
    <div className="grid h-full grid-cols-[300px_1fr]">
      <div className="min-h-0 overflow-y-auto border-r border-line">
        {!list.data ? <Empty>Loading…</Empty> : list.data.length === 0 ? <Empty>No sessions yet. Brief the CEO or run a task.</Empty> : list.data.map((s) => (
          <a key={s.id} href={`#/sessions/${s.id}`}
            className={`block border-b border-line/60 border-l-2 px-4 py-2.5 transition-colors ${s.id === sel ? 'border-l-accent bg-raise' : 'border-l-transparent hover:bg-raise/50'}`}>
            <div className="flex items-center gap-2"><span className="truncate text-[12px]">{s.agent_name}</span><span className="ml-auto"><Status s={s.status} /></span><Dot status={s.status} /></div>
            <div className="mt-1 truncate text-[11px] text-dim">
              {s.purpose !== 'work' && <span className="chip mr-1.5 text-kin">{s.purpose === 'assess' ? 'rating' : s.purpose}</span>}
              {s.task_title ?? (s.purpose === 'plan' ? 'CEO planning' : 'Follow-up message')}
            </div>
            <div className="mt-1 flex gap-3 text-[10.5px] text-faint"><span>{s.model}</span><span>{ago(s.queued_at)}</span></div>
          </a>
        ))}
      </div>
      <div className="flex min-h-0 flex-col">
        {sel ? <Transcript key={sel} id={sel} agentName={cur?.agent_name} onNewSession={(sid) => { location.hash = `#/sessions/${sid}`; }} /> : <Empty>Select a session.</Empty>}
      </div>
    </div>
  );
}
