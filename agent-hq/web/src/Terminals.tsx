import { useEffect, useRef, useState } from 'react';
import { useResource, useLive, ago } from './api';
import { LIVE } from './Transcript';

type Ev = { id: number | string; kind: string; data: any };
const MAX_LINES = 400;

/**
 * Read-only "wall of terminals": one small terminal per working agent, streaming live.
 * When fewer than `slots` are live, the most recent finished sessions fill the rest (dimmed).
 */
export function TeamTerminals({ slots = 4 }: { slots?: number }) {
  const list = useResource<any[]>('/api/sessions', ['session.status']);
  if (!list.data) return null;
  const live = list.data.filter((s) => LIVE.includes(s.status));
  const recent = list.data.filter((s) => !LIVE.includes(s.status)).slice(0, Math.max(0, slots - live.length));
  const shown = [...live, ...recent];

  return (
    <section className="card rise flex flex-col">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-line px-4">
        <span className="label">Team terminals</span>
        <span className="text-[11px] text-faint">{live.length ? `${live.length} working now` : 'nobody working · showing recent'}</span>
        <span className="ml-auto text-[10.5px] text-faint">view only</span>
      </header>
      {shown.length === 0 ? (
        <div className="p-6 text-center text-[12px] text-faint">No sessions yet. Terminals appear here when the team starts working.</div>
      ) : (
        <div className="grid grid-cols-1 gap-3 p-3 lg:grid-cols-2">
          {shown.map((s) => <Terminal key={s.id} s={s} />)}
        </div>
      )}
    </section>
  );
}

function Terminal({ s }: { s: any }) {
  const { data, reload } = useResource<{ session: any; events: Ev[] }>(`/api/sessions/${s.id}`, []);
  const [live, setLive] = useState<Ev[]>([]);
  const [status, setStatus] = useState<string>(s.status);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => { setLive([]); }, [data]);
  useEffect(() => { setStatus(s.status); }, [s.status]);
  useLive((m) => {
    if (m.sessionId !== s.id) return;
    if (m.type === 'session.event') setLive((l) => [...l, { id: `l${l.length}`, kind: m.event.kind, data: m.event }].slice(-MAX_LINES));
    if (m.type === 'session.status') { setStatus(m.status); if (!LIVE.includes(m.status)) setTimeout(reload, 300); }
  });
  const events = [...(data?.events ?? []), ...live].slice(-MAX_LINES);
  useEffect(() => { const el = box.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [events.length]);

  const isLive = LIVE.includes(status);
  const title = s.task_title ?? (s.purpose === 'plan' ? 'CEO planning' : s.purpose === 'assess' ? 'Difficulty rating' : 'Follow-up');

  return (
    <a href={`#/agent/${s.agent_id}`} className={`group flex flex-col overflow-hidden rounded-lg border transition-colors ${isLive ? 'border-kin/40' : 'border-line opacity-70 hover:opacity-100'}`}>
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-raise px-3">
        <span className="flex gap-1">
          <span className="size-2 rounded-full bg-shu/70" /><span className="size-2 rounded-full bg-kin/70" /><span className="size-2 rounded-full bg-matcha/70" />
        </span>
        <span className="ml-1 shrink-0 text-[11.5px] text-ai">{s.agent_name}</span>
        <span className="truncate text-[11px] text-faint">· {title}</span>
        <span className="chip ml-auto shrink-0 text-accent">{s.model}</span>
        <span className={`shrink-0 text-[10px] ${isLive ? 'breathe text-kin' : status === 'completed' ? 'text-matcha' : 'text-shu'}`}>
          {isLive ? `● ${status}` : `${status} · ${ago(s.ended_at ?? s.queued_at)}`}
        </span>
      </div>
      <div ref={box} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30; }}
        className="h-56 overflow-y-auto bg-black/40 px-3 py-2 text-[11px] leading-[1.55]">
        <div className="text-faint">$ claude -p --model {s.model}{s.purpose === 'plan' ? ' --tools Read,Glob,Grep' : ''}</div>
        {events.map((e) => <Line key={e.id} e={e} />)}
        {isLive && <span className="breathe inline-block h-3 w-1.5 translate-y-0.5 bg-fg/80" />}
      </div>
    </a>
  );
}

function Line({ e }: { e: Ev }) {
  const d = e.data;
  switch (e.kind) {
    case 'init': return <div className="text-faint">session {String(d.claudeSessionId ?? '').slice(0, 8)} · {d.tools?.length ?? 0} tools</div>;
    case 'tool_use': return <div className="truncate text-ai">▸ {d.name} <span className="text-dim">{arg(d.input)}</span></div>;
    case 'tool_result': return <div className={`truncate pl-3 ${d.isError ? 'text-shu' : 'text-faint'}`}>{d.isError ? '✕' : '✓'} {firstLine(d.content)}</div>;
    case 'text': return <div className="whitespace-pre-wrap break-words text-fg">{clip(d.text, 6)}</div>;
    case 'stderr': return <div className="truncate text-kin/80">{firstLine(d.text)}</div>;
    case 'result': return <div className={d.ok ? 'text-matcha' : 'text-shu'}>{d.ok ? '✓ done' : `✕ ${d.subtype}`}{d.numTurns != null && ` · ${d.numTurns} turns`}</div>;
    default: return null;
  }
}

const firstLine = (t: string) => String(t ?? '').split('\n').find((l) => l.trim())?.slice(0, 160) ?? '';
const clip = (t: string, n: number) => { const l = String(t ?? '').split('\n'); return l.length > n ? `${l.slice(0, n).join('\n')}\n…` : t; };
function arg(input: any): string {
  if (!input || typeof input !== 'object') return '';
  return String(input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? '').slice(0, 140);
}
