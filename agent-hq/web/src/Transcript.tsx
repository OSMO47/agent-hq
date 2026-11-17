import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, useResource, useLive } from './api';
import { Empty, Status, Dot } from './ui';
import { Markdown } from './Markdown';

type Ev = { id: number | string; kind: string; data: any; created_at?: string };
export const LIVE = ['queued', 'starting', 'running'];

const time = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'));
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

/**
 * One Claude session rendered as a conversation: owner prompt bubble → agent card (text, tool calls, result) → composer.
 * The composer sends a follow-up that resumes the same Claude conversation; onNewSession receives the new session id.
 */
export function Transcript({ id, agentName, onNewSession }: { id: string; agentName?: string; onNewSession?: (sid: string) => void }) {
  const { data, reload } = useResource<{ session: any; events: Ev[] }>(`/api/sessions/${id}`, []);
  const [live, setLive] = useState<Ev[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => { setLive([]); setStatus(null); }, [data]);
  useLive((m) => {
    if (m.sessionId !== id) return;
    if (m.type === 'session.event') setLive((l) => [...l, { id: `l${l.length}`, kind: m.event.kind, data: m.event, created_at: new Date().toISOString() }]);
    if (m.type === 'session.status') { setStatus(m.status); if (!LIVE.includes(m.status)) setTimeout(reload, 300); }
  });
  const events = [...(data?.events ?? []), ...live];
  useEffect(() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [events.length, data]);

  if (!data) return <Empty>Loading…</Empty>;
  const s = data.session;
  const st = status ?? s.status;
  const isLive = LIVE.includes(st);
  const visible = events.filter((e) => ['text', 'tool_use', 'tool_result', 'stderr', 'result'].includes(e.kind));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-line px-5 text-[11px] text-faint">
        <Dot status={st} /><Status s={st} />
        <span className="font-mono">{s.id}</span>
        {s.claude_session_id && <span className="chip text-accent" title="Claude conversation id">{s.claude_session_id.slice(0, 8)}</span>}
        <span className="chip text-ai">{s.model}</span>
        {s.purpose !== 'work' && <span className="chip text-kin">{s.purpose === 'assess' ? 'rating' : s.purpose}</span>}
        <div className="ml-auto flex items-center gap-3">
          {s.num_turns != null && <span>{s.num_turns} turns · {fmtK(s.input_tokens)} in · {fmtK(s.output_tokens)} out</span>}
          {s.cost_usd_estimate != null && <span className="pill text-matcha" title="API-equivalent estimate; not a bill on a subscription">${s.cost_usd_estimate.toFixed(2)}</span>}
          {isLive && <button className="btn btn-danger h-6" onClick={() => api('POST', `/api/sessions/${id}/stop`)}>■ Stop</button>}
        </div>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5"
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
        <Row at={time(s.queued_at)}>
          <div className="rounded-xl border border-accent/30 bg-accent/[.07] px-4 py-3">
            <Collapsible text={s.prompt} lines={14} />
          </div>
        </Row>

        {(visible.length > 0 || isLive || s.error) && (
          <Row at={time(s.started_at)}>
            <div className="rounded-xl border border-line bg-panel px-4 py-3">
              <div className="mb-2 text-[11px] text-ai">{agentName ?? s.agent_id}</div>
              {visible.map((e) => <EventLine key={e.id} e={e} />)}
              {isLive && <div className="breathe mt-2 text-[12px] text-kin">● {st === 'queued' ? 'waiting for a free slot…' : 'thinking…'}</div>}
              {s.error && <div className="mt-2 whitespace-pre-wrap text-[12px] text-shu">{s.error}</div>}
            </div>
          </Row>
        )}
      </div>

      <Composer disabled={isLive || !s.claude_session_id}
        placeholder={isLive ? `${agentName ?? 'Agent'} is working: wait, or stop it` : s.claude_session_id ? `Talking to ${agentName ?? 'agent'} powered by Claude` : 'No Claude conversation to continue'}
        onSend={async (text) => { const r = await api('POST', `/api/sessions/${id}/message`, { text }); onNewSession?.(r.sessionId); }} />
    </div>
  );
}

const fmtK = (n?: number | null) => (n == null ? '–' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function Row({ at, children }: { at: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[52px_1fr] gap-3">
      <div className="pt-3 text-right text-[10.5px] text-faint">{at}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Collapsible({ text, lines, md }: { text: string; lines: number; md?: boolean }) {
  const [open, setOpen] = useState(false);
  const all = (text ?? '').split('\n');
  const long = all.length > lines;
  const shown = long && !open ? all.slice(0, lines).join('\n') : text;
  return (
    <>
      {md ? <Markdown text={shown} /> : <div className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed">{shown}</div>}
      {long && <button className="btn mt-2 h-6 text-[11px] text-accent" onClick={() => setOpen(!open)}>{open ? '⌃ Show less' : `⌄ Show all ${all.length} lines`}</button>}
    </>
  );
}

export function Composer({ placeholder, disabled, onSend }: { placeholder: string; disabled?: boolean; onSend: (text: string) => Promise<void> }) {
  const [v, setV] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  async function send() {
    if (!v.trim() || disabled || busy) return;
    setBusy(true); setErr('');
    try { await onSend(v.trim()); setV(''); } catch (x) { setErr((x as Error).message); }
    setBusy(false);
  }
  return (
    <div className="shrink-0 border-t border-line p-3">
      <div className="flex items-end gap-2">
        <div className={`flex-1 rounded-xl border bg-ink px-3 pb-1.5 pt-2.5 transition-colors ${disabled ? 'border-line opacity-60' : 'border-line-strong focus-within:border-accent'}`}>
          <textarea rows={2} className="w-full resize-none bg-transparent text-[12.5px] outline-none placeholder:text-faint" placeholder={placeholder}
            disabled={disabled} value={v} onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <div className="flex justify-end gap-4 text-[10.5px] text-faint"><span>⇧ + Enter newline</span><span>Enter send</span></div>
        </div>
        <button className="btn btn-primary !h-11 !w-11 shrink-0 !rounded-xl !p-0 text-[17px]" disabled={disabled || busy || !v.trim()} onClick={send} aria-label="Send">↑</button>
      </div>
      {err && <div className="mt-2 text-[11.5px] text-shu">{err}</div>}
    </div>
  );
}

function EventLine({ e }: { e: Ev }) {
  const d = e.data;
  switch (e.kind) {
    case 'text': return <div className="mb-3 last:mb-0"><Collapsible text={d.text} lines={40} md /></div>;
    case 'tool_use': return <div className="mb-1 truncate text-[11.5px] text-ai">▸ {d.name} <span className="text-faint">{summarize(d.input)}</span></div>;
    case 'tool_result': return (
      <details className="mb-2 pl-3 text-[11px] text-faint">
        <summary className={`cursor-pointer ${d.isError ? 'text-shu' : ''}`}>{d.isError ? '✕ error' : '✓ result'} · {d.content.length} chars</summary>
        <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-ink p-2">{d.content}</pre>
      </details>);
    case 'stderr': return <div className="mb-1 whitespace-pre-wrap text-[11px] text-kin/80">{d.text}</div>;
    case 'result': return (
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-2 text-[11px]">
        <span className={`pill ${d.ok ? 'text-matcha' : 'text-shu'}`}>{d.ok ? '✓ completed' : `ended: ${d.subtype}`}</span>
        {d.permissionDenials?.length > 0 && <span className="text-kin">Denied by policy: {d.permissionDenials.map((p: any) => `${p.tool} ${summarize(p.input)}`).join(' · ')}</span>}
      </div>);
    default: return null;
  }
}

function summarize(input: any): string {
  if (!input || typeof input !== 'object') return '';
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? '';
  return String(v).slice(0, 140);
}
