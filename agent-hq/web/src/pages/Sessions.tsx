import { useState } from 'react';
import { useResource, ago } from '../api';
import { Dot, Empty, Status } from '../ui';
import { Transcript } from '../Transcript';
import { OfficeFloor } from './OfficeFloor';

/** Every session across the organization, newest first. Top: the office floor (who's working at their desk, who's idle). Bottom: the selected session's conversation. */
export default function Sessions({ param }: { param?: string }) {
  const list = useResource<any[]>('/api/sessions', ['session.status']);
  const org = useResource<{ departments: any[]; agents: any[] }>('/api/org', ['org']);
  const sel = param ?? list.data?.[0]?.id ?? null;
  const cur = list.data?.find((s) => s.id === sel);
  const [office, setOffice] = useState(true);
  const working = list.data?.filter((s) => s.status === 'running').length ?? 0;
  const queued = list.data?.filter((s) => s.status === 'queued').length ?? 0;
  const go = (sid: string) => { location.hash = `#/sessions/${sid}`; };

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
        <div className="shrink-0 border-b border-line">
          <div className="flex items-center gap-3 px-4 py-2 text-[11px]">
            <span className="font-semibold text-fg">ออฟฟิศ</span>
            <span className="text-matcha">● ทำงานอยู่ {working}</span>
            {queued > 0 && <span className="text-kin">รอคิว {queued}</span>}
            <span className="text-faint">คลิกที่คนเพื่อเปิด session ของเขา</span>
            <button type="button" className="ml-auto text-faint hover:text-fg" onClick={() => setOffice((o) => !o)}>{office ? 'ย่อ ▲' : 'แสดงออฟฟิศ ▼'}</button>
          </div>
          {office && (
            <div className="px-4 pb-4">
              {org.data && list.data
                ? <OfficeFloor agents={org.data.agents} departments={org.data.departments} sessions={list.data} selectedSessionId={sel} onSelect={go} />
                : <Empty>Loading…</Empty>}
            </div>
          )}
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          {sel ? <Transcript key={sel} id={sel} agentName={cur?.agent_name} onNewSession={go} /> : <Empty>Select a session.</Empty>}
        </div>
      </div>
    </div>
  );
}
