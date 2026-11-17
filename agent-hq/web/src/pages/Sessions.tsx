import { useEffect, useRef, useState } from 'react';
import { api, useResource, useLive, ago } from '../api';
import { Dot, Empty, Status } from '../ui';

type Ev = { id: number | string; kind: string; data: any };
const LIVE = ['queued', 'starting', 'running'];

export default function Sessions({ param }: { param?: string }) {
  const list = useResource<any[]>('/api/sessions', ['session.status']);
  const sel = param ?? list.data?.[0]?.id ?? null;

  return (
    <div className="grid h-full grid-cols-[320px_1fr]">
      <div className="min-h-0 overflow-y-auto border-r border-line">
        {!list.data ? <Empty>Loading…</Empty> : list.data.length === 0 ? <Empty>No sessions yet. Run a task from the Tasks board.</Empty> : list.data.map((s) => (
          <a key={s.id} href={`#/sessions/${s.id}`}
            className={`block border-b border-line/60 px-4 py-2.5 transition-colors ${s.id === sel ? 'bg-raise' : 'hover:bg-raise/50'}`}>
            <div className="flex items-center gap-2"><Dot status={s.status} /><span className="truncate text-[12.5px]">{s.role}</span><span className="ml-auto"><Status s={s.status} /></span></div>
            <div className="mt-1 truncate pl-3.5 text-[11.5px] text-dim">{s.task_title ?? 'Follow-up message'}</div>
            <div className="mt-1 flex gap-3 pl-3.5 font-mono text-[10.5px] text-faint">
              <span>{s.model}</span><span>{ago(s.queued_at)}</span>
              {s.input_tokens != null && <span>{Math.round(s.input_tokens / 1000)}k in · {s.output_tokens} out</span>}
            </div>
          </a>
        ))}
      </div>
      {sel ? <SessionView key={sel} id={sel} onChange={list.reload} /> : <Empty>Select a session.</Empty>}
    </div>
  );
}

function SessionView({ id, onChange }: { id: string; onChange: () => void }) {
  const { data, reload } = useResource<{ session: any; events: Ev[] }>(`/api/sessions/${id}`, []);
  const [live, setLive] = useState<Ev[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => { setLive([]); setStatus(null); }, [data]);
  useLive((m) => {
    if (m.sessionId !== id) return;
    if (m.type === 'session.event') setLive((l) => [...l, { id: `l${l.length}`, kind: m.event.kind, data: m.event }]);
    if (m.type === 'session.status') { setStatus(m.status); if (!LIVE.includes(m.status)) setTimeout(reload, 300); }
  });
  const events = [...(data?.events ?? []), ...live];
  useEffect(() => { if (stick.current) bottom.current?.scrollIntoView({ block: 'end' }); }, [events.length]);

  if (!data) return <Empty>Loading…</Empty>;
  const s = data.session;
  const st = status ?? s.status;
  const isLive = LIVE.includes(st);

  async function send(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    try { const r = await api('POST', `/api/sessions/${id}/message`, { text: msg }); setMsg(''); onChange(); location.hash = `#/sessions/${r.sessionId}`; }
    catch (x) { setErr((x as Error).message); }
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-5">
        <Dot status={st} /><span className="font-mono text-[12px]">{s.id}</span><Status s={st} />
        {s.claude_session_id && <span className="font-mono text-[10.5px] text-faint" title="Claude conversation id">claude:{s.claude_session_id.slice(0, 8)}</span>}
        {s.task_id && <a className="text-[11.5px] text-ai hover:underline" href="#/tasks">task</a>}
        <div className="ml-auto flex items-center gap-3">
          {s.num_turns != null && <span className="font-mono text-[11px] text-faint">{s.num_turns} turns · {s.input_tokens?.toLocaleString()} in · {s.output_tokens?.toLocaleString()} out{s.cost_usd_estimate != null && ` · ~$${s.cost_usd_estimate.toFixed(3)} est.`}</span>}
          {isLive && <button className="btn btn-danger" onClick={() => api('POST', `/api/sessions/${id}/stop`).then(onChange)}>Stop</button>}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-ink px-5 py-4 font-mono text-[12px] leading-relaxed"
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        <Block tone="text-faint" label="prompt">{s.prompt}</Block>
        {events.map((e) => <EventLine key={e.id} e={e} />)}
        {isLive && <div className="breathe mt-2 text-matcha">● working…</div>}
        {s.error && <Block tone="text-shu" label="error">{s.error}</Block>}
        <div ref={bottom} />
      </div>

      <form onSubmit={send} className="flex shrink-0 gap-2 border-t border-line p-3">
        <input className="field" disabled={isLive || !s.claude_session_id} value={msg} onChange={(e) => setMsg(e.target.value)}
          placeholder={isLive ? 'Agent is working — wait for it to finish, or stop it' : s.claude_session_id ? 'Follow-up instruction (continues the same Claude conversation)…' : 'No Claude conversation to continue'} />
        <button className="btn btn-primary" disabled={isLive || !msg.trim()}>Send</button>
      </form>
      {err && <div className="px-4 pb-3 text-[12px] text-shu">{err}</div>}
    </div>
  );
}

function Block({ label, tone, children }: { label: string; tone: string; children: React.ReactNode }) {
  return <div className="mb-3"><div className="mb-0.5 text-[10px] uppercase tracking-widest text-faint">{label}</div><div className={`whitespace-pre-wrap break-words ${tone}`}>{children}</div></div>;
}

function EventLine({ e }: { e: Ev }) {
  const d = e.data;
  switch (e.kind) {
    case 'init': return <div className="mb-2 text-faint">— session started · {d.model} · tools: {d.tools?.length ? d.tools.join(', ') : 'none'}</div>;
    case 'text': return <div className="mb-3 whitespace-pre-wrap break-words font-sans text-[13px] text-fg">{d.text}</div>;
    case 'tool_use': return <div className="mb-1 text-ai">▸ {d.name} <span className="text-faint">{summarize(d.input)}</span></div>;
    case 'tool_result': return <details className="mb-2 pl-3 text-faint"><summary className={`cursor-pointer ${d.isError ? 'text-shu' : ''}`}>{d.isError ? '✕ error' : '✓ result'} · {d.content.length} chars</summary><pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap">{d.content}</pre></details>;
    case 'stderr': return <div className="mb-1 whitespace-pre-wrap text-kin/80">{d.text}</div>;
    case 'rate_limit': return null;
    case 'result': return (
      <div className={`mt-3 rounded-md border p-3 font-sans ${d.ok ? 'border-matcha/30' : 'border-shu/40'}`}>
        <div className={`mb-1 text-[11px] ${d.ok ? 'text-matcha' : 'text-shu'}`}>{d.ok ? 'Completed' : `Ended: ${d.subtype}`}</div>
        {d.permissionDenials?.length > 0 && <div className="mb-2 text-[12px] text-kin">Denied by policy: {d.permissionDenials.map((p: any) => `${p.tool} ${summarize(p.input)}`).join(' · ')}</div>}
      </div>);
    default: return null;
  }
}

function summarize(input: any): string {
  if (!input || typeof input !== 'object') return '';
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? '';
  return String(v).slice(0, 140);
}
