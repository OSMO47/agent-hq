import { useEffect, useState, type ReactNode } from 'react';
import { useResource, useLive, ago } from './api';
import { LIVE } from './Transcript';
import { AgentIcon } from './AgentIcon';
import { Avatar } from './Avatar';
import { Check, Copy, ExternalLink, X } from 'lucide-react';

type Ev = { id: number | string; kind: string; data: any };
const MAX_LINES = 60;
export type Layout = 'grid' | 'fit';

/**
 * Wall of agent sessions (view only). Live sessions first, then ones that finished in the last hour (dimmed).
 * 'grid' = fixed 4×3 board, empty slots show idle agents; 'fit' = only sessions, as many columns as fit.
 */
const HIDDEN_KEY = 'hq.wall.hidden';
const readHidden = (): string[] => { try { return JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]'); } catch { return []; } };

export function SessionWall({ layout, setLayout }: { layout: Layout; setLayout: (l: Layout) => void }) {
  const [hidden, setHiddenState] = useState<string[]>(readHidden);
  const [showAll, setShowAll] = useState(false);
  const setHidden = (h: string[]) => { setHiddenState(h); try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(h.slice(-200))); } catch { /* private mode */ } };
  const list = useResource<any[]>('/api/sessions', ['session.status']);
  const org = useResource<{ agents: any[] }>('/api/org', ['org', 'session.status']);
  const projects = useResource<any[]>('/api/projects', ['project']);
  const tasks = useResource<{ tasks: any[] }>('/api/tasks', ['task']);
  if (!list.data || !org.data) return <div className="p-8 text-center text-[12px] text-faint">Loading…</div>;
  const projectName = Object.fromEntries((projects.data ?? []).map((p) => [p.id, p.name]));
  const taskById = Object.fromEntries((tasks.data?.tasks ?? []).map((t) => [t.id, t]));
  const projectOf = (s: any) => projectName[s.project_id ?? taskById[s.task_id]?.project_id] ?? null;

  const live = list.data.filter((s) => LIVE.includes(s.status));
  const hourAgo = Date.now() - 3600_000;
  const recent = list.data.filter((s) => !LIVE.includes(s.status) && when(s.ended_at ?? s.queued_at) > hourAgo);
  const seen = new Set<string>();
  // One card per agent: its newest session.
  const sessions = [...live, ...recent].filter((s) => (seen.has(s.agent_id) ? false : (seen.add(s.agent_id), true)));
  const slots = layout === 'grid' ? 12 : 24;
  const visible = showAll ? sessions : sessions.filter((s) => !hidden.includes(s.id));
  const cards = showAll ? visible : visible.slice(0, slots);
  const hiddenCount = sessions.length - cards.length;
  const idle = layout === 'grid' && !showAll
    ? org.data.agents.filter((a) => a.status === 'active' && !seen.has(a.id)).slice(0, Math.max(0, slots - cards.length))
    : [];

  const jump = (id: string) => {
    const el = document.getElementById(`card-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.focus({ preventScroll: true });
    el.animate([{ outline: '2px solid var(--color-accent)', outlineOffset: '2px' }, { outline: '2px solid transparent', outlineOffset: '6px' }], { duration: 1200, easing: 'ease-out' });
  };

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="label">Active sessions</span>
        <span className="text-[11px] text-faint">
          {live.length ? `${live.length} working now` : 'nobody working'} · {cards.length} shown{hiddenCount > 0 && `, ${hiddenCount} hidden`}
        </span>
        {hiddenCount > 0 && <button className="text-[11px] text-ai hover:underline" onClick={() => { setShowAll(true); setHidden([]); }}>Show all</button>}
        {showAll && sessions.length > slots && <button className="text-[11px] text-faint hover:text-fg" onClick={() => setShowAll(false)}>Show less</button>}
        <div className="ml-auto flex items-center gap-2">
          {cards.length > 1 && (
            <label className="relative">
              <span className="sr-only">Jump to session</span>
              <select value="" onChange={(e) => e.target.value && jump(e.target.value)}
                className="h-7 max-w-[220px] cursor-pointer appearance-none rounded-lg border border-line-strong bg-ink py-0 pl-2.5 pr-7 text-[11px] text-dim outline-none hover:text-fg focus:border-accent">
                <option value="">Jump to…</option>
                {cards.map((s) => <option key={s.id} value={s.id}>{heading(s.agent_name, s.role ?? s.agent_name).main} · {s.task_title ?? s.purpose}</option>)}
              </select>
              <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[9px] text-faint">▼</span>
            </label>
          )}
          <div className="inline-flex rounded-lg border border-line-strong bg-ink p-0.5" role="group" aria-label="Layout">
            {([['grid', '4×3'], ['fit', 'Auto-fit']] as const).map(([k, l]) => (
              <button key={k} onClick={() => setLayout(k)} aria-pressed={layout === k}
                className={`h-6 rounded-md px-2.5 text-[11px] transition-colors ${layout === k ? 'bg-fg font-semibold text-ink' : 'text-dim hover:text-fg'}`}>{l}</button>
            ))}
          </div>
        </div>
      </div>

      {cards.length === 0 && idle.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line-strong p-10 text-center text-[12px] text-faint">Nobody is working right now. Cards appear here as soon as an agent starts a task.</div>
      ) : (
        <div className={layout === 'grid'
          ? 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4'
          : 'grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3'}>
          {cards.map((s) => <SessionCard key={s.id} s={s} project={projectOf(s)} agent={org.data!.agents.find((a) => a.id === s.agent_id)}
            awaitingOwner={taskById[s.task_id]?.status === 'REVIEW' && taskById[s.task_id]?.review_status === 'pending'}
            onHide={() => { setShowAll(false); setHidden([...hidden, s.id]); }} />)}
          {idle.map((a) => <IdleCard key={a.id} a={a} />)}
        </div>
      )}
    </>
  );
}

const when = (t?: string | null) => (t ? new Date(t.includes('T') ? t : `${t.replace(' ', 'T')}Z`).getTime() : 0);
/** "CTO / Technical Director" → "CTO"; "Frontend Developer" → "Frontend". */
const shortRole = (role: string) => role.replace(/\s+\/.*$/, '').replace(/ (Developer|Engineer)$/, '');
/** Card heading: specialists are named after their role, leaders have a personal name + role. */
const heading = (name: string, role: string) => (name === role ? { main: shortRole(role), sub: '' } : { main: name, sub: shortRole(role) });

type Tone = 'live' | 'done' | 'approval' | 'failed' | 'idle';
/** Border by state: working = matcha + soft glow, waiting for the owner = kin, error = shu, otherwise the plain line. */
const TONE: Record<Tone, string> = {
  live: 'border-matcha/60 shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-matcha)_18%,transparent),0_6px_24px_-6px_color-mix(in_srgb,var(--color-matcha)_35%,transparent)]',
  approval: 'border-kin/60 shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-kin)_14%,transparent)]',
  failed: 'border-shu/55',
  done: 'border-line opacity-80 hover:opacity-100',
  idle: 'border-line border-dashed opacity-75 hover:opacity-100',
};

function CardFrame({ id, href, tone, children }: { id?: string; href: string; tone: Tone; children: ReactNode }) {
  return (
    <a id={id} href={href}
      className={`group flex scroll-mt-4 flex-col overflow-hidden rounded-lg border bg-panel shadow-[0_1px_2px_rgb(0_0_0/0.12)] transition-[border-color,box-shadow,opacity,background-color] duration-300 ease-out hover:border-line-strong hover:bg-raise/40 ${tone === 'idle' ? 'min-h-[92px]' : 'h-[216px]'} ${TONE[tone]}`}>
      {children}
    </a>
  );
}

/** Footer chip: only rendered when there is a value. */
const Chip = ({ children, tone = '' }: { children: ReactNode; tone?: string }) => (
  <span className={`shrink-0 rounded border border-line px-1.5 leading-[18px] ${tone}`}>{children}</span>
);
const duration = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  return m < 1 ? `${Math.max(1, Math.round(ms / 1000))}s` : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

/** The agent's picture with the runtime (Claude Code) as a small corner badge. */
const Face = ({ agent }: { agent: { id: string; name: string; avatar?: number | null } }) => (
  <Avatar agent={agent} size={28} badge={<AgentIcon kind="claude" size={14} title="Claude Code" />} />
);

function CardHead({ agent, dot, name, role, dim }: { agent: any; dot: string; name: string; role: string; dim?: boolean }) {
  const h = heading(name, role);
  return (
    <div className="flex min-w-0 items-center gap-2 px-3 pt-2.5">
      <Face agent={agent} />
      <span className={`shrink-0 text-[11.5px] font-semibold uppercase tracking-[.09em] ${dim ? 'text-dim' : ''}`}>{h.main}</span>
      {h.sub && <span className="min-w-0 truncate text-[10.5px] text-faint">{h.sub}</span>}
      <span className={`ml-auto size-2 shrink-0 rounded-full ${dot}`} />
    </div>
  );
}

/** Hover-only icon button in a card header (the card itself is a link, so stop it from navigating). */
function Action({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}
      className="inline-flex size-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-raise hover:text-fg">
      {children}
    </button>
  );
}

function SessionCard({ s, agent, project, awaitingOwner, onHide }: { s: any; agent?: any; project: string | null; awaitingOwner: boolean; onHide?: () => void }) {
  const { data, reload } = useResource<{ session: any; events: Ev[] }>(`/api/sessions/${s.id}`, []);
  const [live, setLive] = useState<Ev[]>([]);
  const [status, setStatus] = useState<string>(s.status);
  useEffect(() => { setLive([]); }, [data]);
  useEffect(() => { setStatus(s.status); }, [s.status]);
  useLive((m) => {
    if (m.sessionId !== s.id) return;
    if (m.type === 'session.event') setLive((l) => [...l, { id: `l${l.length}`, kind: m.event.kind, data: m.event }].slice(-MAX_LINES));
    if (m.type === 'session.status') { setStatus(m.status); if (!LIVE.includes(m.status)) setTimeout(reload, 300); }
  });
  const lines = [...(data?.events ?? []), ...live].filter((e) => SHOWN.has(e.kind)).slice(-7);
  const isLive = LIVE.includes(status);
  const failed = ['failed', 'timeout'].includes(status);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const text = data?.session?.result_text
      || [...(data?.events ?? []), ...live].filter((e) => e.kind === 'text').map((e) => e.data.text).join('\n\n');
    try { await navigator.clipboard.writeText(text || ''); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* clipboard blocked */ }
  };
  const title = s.task_title ?? (s.purpose === 'plan' ? 'Planning' : s.purpose === 'assess' ? 'Rating difficulty' : s.purpose === 'dispatch' ? 'Assigning work' : s.purpose === 'meeting' ? 'Meeting' : 'Follow-up');

  const tone: Tone = isLive ? 'live' : failed ? 'failed' : awaitingOwner ? 'approval' : 'done';
  const sess = data?.session ?? s;
  const started = when(sess.started_at);
  const elapsed = started ? (isLive ? Date.now() : when(sess.ended_at) || Date.now()) - started : 0;

  return (
    <CardFrame id={`card-${s.id}`} href={`#/agent/${s.agent_id}`} tone={tone}>
      <div className="flex min-w-0 items-center gap-2 px-3 pt-2.5">
        <Face agent={agent ?? { id: s.agent_id, name: s.agent_name }} />
        <span className="shrink-0 truncate text-[12.5px] font-bold">{project ?? 'OSMO AGENT'}</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-faint" title={title}>{title}</span>
        <span className={`size-2 shrink-0 rounded-full transition-colors duration-300 ${isLive ? 'breathe bg-matcha' : failed ? 'bg-shu' : awaitingOwner ? 'bg-kin' : 'bg-ai'}`}
          title={awaitingOwner && !isLive ? 'waiting for your approval' : status} />
        {/* takes no width until hover/focus, so the task title keeps the room */}
        <span className="-ml-2 flex max-w-0 shrink-0 items-center gap-0.5 overflow-hidden opacity-0 transition-[max-width,opacity,margin] duration-200 group-hover:ml-0 group-hover:max-w-[84px] group-hover:opacity-100 group-focus-within:ml-0 group-focus-within:max-w-[84px] group-focus-within:opacity-100">
          <Action label="Open conversation" onClick={() => { location.hash = `#/agent/${s.agent_id}`; }}><ExternalLink size={13} /></Action>
          <Action label={copied ? 'Copied' : 'Copy output'} onClick={copy}>{copied ? <Check size={13} className="text-matcha" /> : <Copy size={13} />}</Action>
          {onHide && <Action label="Hide from wall" onClick={onHide}><X size={13} /></Action>}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 pb-2 pl-[44px] pr-3 pt-0.5 text-[10.5px] uppercase tracking-[.08em] text-dim">
        <span className="truncate">{heading(s.agent_name, s.role ?? s.agent_name).main}</span>
      </div>
      <div className="mx-2 flex min-h-0 flex-1 flex-col justify-end overflow-hidden rounded-md bg-ink/70 px-2.5 py-2 text-[11px] leading-[1.6] [mask-image:linear-gradient(to_bottom,transparent,black_28px)]">
        {/* shrink-0: newest lines stay whole at the bottom; older ones scroll off the top */}
        {lines.length === 0 && <div className="shrink-0 text-faint">{isLive ? 'Starting…' : 'No output.'}</div>}
        {lines.map((e) => <div key={e.id} className="shrink-0"><Line e={e} /></div>)}
        <div className="flex shrink-0 items-center gap-2 pt-0.5 text-[10.5px]">
          {isLive
            ? <span className="breathe inline-block h-3 w-1.5 bg-fg/80" />
            : <span className={failed ? 'text-shu' : 'text-faint'}>{status} · {ago(s.ended_at ?? s.queued_at)}</span>}
        </div>
      </div>
      {/* status bar: only data the session already has (no git branch is recorded per session, so none is shown) */}
      <div className="mt-2 flex min-w-0 items-center gap-1.5 overflow-hidden border-t border-line/70 px-3 py-1.5 font-mono text-[10.5px] text-faint">
        {sess.model && <Chip tone="text-accent">{sess.model}</Chip>}
        {elapsed > 0 && <Chip>⏱ {duration(elapsed)}</Chip>}
        {sess.num_turns != null && <Chip>{sess.num_turns} turns</Chip>}
        {sess.cost_usd_estimate != null && <Chip>${Number(sess.cost_usd_estimate).toFixed(2)}</Chip>}
        {awaitingOwner && !isLive && <Chip tone="border-kin/40 text-kin">needs you</Chip>}
      </div>
    </CardFrame>
  );
}

function IdleCard({ a }: { a: any }) {
  return (
    <CardFrame href={`#/agent/${a.id}`} tone="idle">
      <CardHead agent={a} dot="border border-faint" name={a.name} role={a.role} dim />
      <div className="pl-[44px] pr-3 pt-0.5 text-[10.5px] uppercase tracking-[.09em] text-faint">Idle</div>
      <div className="flex flex-1 items-end px-3 pb-3 text-[11.5px] text-faint">Waiting for work…</div>
    </CardFrame>
  );
}

const SHOWN = new Set(['tool_use', 'tool_result', 'text', 'result']);

function Line({ e }: { e: Ev }) {
  const d = e.data;
  switch (e.kind) {
    case 'tool_use': return <div className="truncate text-ai">▸ {d.name} <span className="text-dim">{arg(d.input)}</span></div>;
    case 'tool_result': return <div className={`truncate pl-3 ${d.isError ? 'text-shu' : 'text-faint'}`}>{d.isError ? '✕' : '✓'} {firstLine(d.content)}</div>;
    case 'text': return <div className="line-clamp-2 break-words text-fg">{firstLine(d.text)}</div>;
    case 'result': return <div className={d.ok ? 'text-matcha' : 'text-shu'}>{d.ok ? '✓ done' : `✕ ${d.subtype}`}{d.numTurns != null && ` · ${d.numTurns} turns`}</div>;
    default: return null;
  }
}

const firstLine = (t: string) => String(t ?? '').split('\n').find((l) => l.trim())?.slice(0, 200) ?? '';
function arg(input: any): string {
  if (!input || typeof input !== 'object') return '';
  const v = String(input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? '');
  return v.replace(/^.*[\\/](?=[^\\/]+$)/, (m) => (input.file_path || input.path ? '' : m)).slice(0, 140);
}
