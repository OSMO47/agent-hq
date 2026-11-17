import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { api, useConnected, useResource, useLive, ago } from './api';
import { Empty, Status } from './ui';
import Overview from './pages/Overview';
import Organization from './pages/Organization';
import Tasks from './pages/Tasks';
import Sessions from './pages/Sessions';
import Settings from './pages/Settings';
import Agent from './pages/Agent';

const PAGES = [
  { id: 'overview', name: 'Overview', key: '1', C: Overview },
  { id: 'tasks', name: 'Task board', key: '2', C: Tasks },
  { id: 'sessions', name: 'Live sessions', key: '3', C: Sessions },
  { id: 'org', name: 'Organization', key: '4', C: Organization },
  { id: 'settings', name: 'Settings', key: '5', C: Settings },
] as const;
const THEMES = [['pedurple', 'Pedurple'], ['dracula', 'Dracula'], ['nord', 'Nord'], ['github', 'GitHub Light']] as const;

const store = {
  get: (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

function useHashRoute() {
  const read = () => location.hash.slice(2) || 'overview';
  const [r, setR] = useState(read);
  useEffect(() => { const f = () => setR(read()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return r;
}

function useTheme() {
  const [t, setT] = useState(() => store.get('hq.theme', 'pedurple'));
  useEffect(() => { document.documentElement.dataset.theme = t; store.set('hq.theme', t); }, [t]);
  return [t, setT] as const;
}

/** Busy = has a live session. Green ready · yellow busy · red suspended · grey inactive. */
const agentState = (a: any) => (a.status === 'suspended' ? 'suspended' : a.status !== 'active' ? 'inactive' : a.session_status ? 'busy' : 'ready');
const STATE_BG: Record<string, string> = { ready: 'bg-matcha', busy: 'bg-kin', suspended: 'bg-shu', inactive: 'bg-faint' };
const StateDot = ({ a }: { a: any }) => {
  const s = agentState(a);
  return <span title={s} className={`inline-block size-2 shrink-0 rounded-full ${STATE_BG[s]} ${s === 'busy' ? 'breathe' : ''}`} />;
};

function App() {
  const route = useHashRoute();
  const [page, param] = route.split('/');
  const [theme, setTheme] = useTheme();
  const connected = useConnected();
  const ov = useResource<any>('/api/overview', ['session.status', 'paused', 'limited', 'org'], 15000);
  const org = useResource<{ departments: any[]; agents: any[] }>('/api/org', ['org', 'session.status']);
  const [right, setRight] = useState(() => store.get('hq.right', '1') === '1');
  useEffect(() => store.set('hq.right', right ? '1' : '0'), [right]);
  const [toast, setToast] = useState<string | null>(null);
  useLive((m) => { if (m.type === 'limited') setToast(`Usage limit reached: queue resumes at ${new Date(m.until).toLocaleTimeString()}`); });

  // Ctrl+1…5 jump between pages, Ctrl+. toggles the right bar.
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const p = PAGES.find((x) => x.key === e.key);
      if (p) { e.preventDefault(); location.hash = `#/${p.id}`; }
      if (e.key === '.') { e.preventDefault(); setRight((r) => !r); }
    };
    addEventListener('keydown', f); return () => removeEventListener('keydown', f);
  }, []);

  const agent = page === 'agent' ? org.data?.agents.find((a) => a.id === param) : null;
  const Page = page === 'agent' ? Agent : (PAGES.find((p) => p.id === page) ?? PAGES[0]).C;

  return (
    <div className={`grid h-full ${right ? 'grid-cols-[280px_1fr_320px]' : 'grid-cols-[280px_1fr]'}`}>
      <LeftBar org={org.data} connected={connected} current={page === 'agent' ? param : null} page={page}
        theme={theme} setTheme={setTheme} paused={ov.data?.paused} reloadOv={ov.reload} onToast={setToast} />

      <div className="flex min-h-0 min-w-0 flex-col">
        <CenterHeader agent={agent} org={org.data} page={page} ov={ov.data} reloadOv={ov.reload} onToast={setToast} right={right} setRight={setRight} />
        <main className="min-h-0 flex-1 overflow-auto">
          <Page param={param} overview={ov.data} />
        </main>
      </div>

      {right && <RightBar agentId={agent?.id ?? null} agents={org.data?.agents ?? []} />}

      {toast && (
        <div className="rise fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-accent/40 bg-raise px-4 py-2.5 text-[12px] shadow-2xl">
          {toast}<button className="text-faint hover:text-fg" onClick={() => setToast(null)} aria-label="Dismiss">✕</button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Left Bar
function LeftBar({ org, connected, current, page, theme, setTheme, paused, reloadOv, onToast }:
  { org: any; connected: boolean; current: string | null; page: string; theme: string; setTheme: (t: string) => void; paused: boolean; reloadOv: () => void; onToast: (s: string) => void }) {
  const [menu, setMenu] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => { try { return JSON.parse(store.get('hq.collapsed', '{}')); } catch { return {}; } });
  const toggle = (id: string) => { const n = { ...collapsed, [id]: !collapsed[id] }; setCollapsed(n); store.set('hq.collapsed', JSON.stringify(n)); };

  const agents: any[] = org?.agents ?? [];
  const groups = org ? [
    { id: 'exec', name: 'Executive', agents: agents.filter((a) => a.level === 1) },
    ...org.departments.map((d: any) => ({ id: d.id, name: d.name, agents: agents.filter((a) => a.department_id === d.id && a.level > 1).sort((a, b) => a.level - b.level) })),
  ] : [];
  const busy = agents.filter((a) => agentState(a) === 'busy').length;

  return (
    <aside className="relative flex min-h-0 flex-col border-r border-line bg-panel">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
        <span className="text-[17px] text-accent">✦</span>
        <span className="text-[15px] font-bold tracking-[.12em]">AGENT HQ</span>
        {busy > 0 && <span className="text-[11px] text-kin" title="Agents working now">⚙ {busy}</span>}
        <span className={`ml-auto flex items-center gap-1.5 text-[10.5px] tracking-wider ${connected ? 'text-matcha' : 'text-shu'}`}>
          <span className={`size-1.5 rounded-full ${connected ? 'bg-matcha' : 'bg-shu breathe'}`} />{connected ? 'LIVE' : 'OFFLINE'}
        </span>
        <button className="btn btn-ghost h-7 w-7 p-0 text-[15px]" onClick={() => setMenu(!menu)} aria-label="Menu" aria-expanded={menu}>☰</button>
      </div>
      {menu && <Menu page={page} theme={theme} setTheme={setTheme} paused={paused} reloadOv={reloadOv} onToast={onToast} onClose={() => setMenu(false)} />}

      <nav className="min-h-0 flex-1 overflow-y-auto py-2">
        {!org && <Empty>Loading…</Empty>}
        {groups.map((g) => {
          const shut = collapsed[g.id];
          return (
            <div key={g.id} className="mb-1">
              <button onClick={() => toggle(g.id)} className="flex h-8 w-full items-center gap-2 px-4 text-left text-[11.5px] font-bold uppercase tracking-wider text-dim hover:text-fg">
                <span className={`inline-block w-3 text-faint transition-transform ${shut ? '' : 'rotate-90'}`}>›</span>
                <span className="truncate">{g.name}</span>
                <span className="ml-auto font-normal text-faint">{g.agents.length}</span>
              </button>
              {shut ? (
                <div className="flex gap-1 px-4 pb-2 pl-9">
                  {g.agents.map((a: any) => <span key={a.id} title={`${a.name}: ${agentState(a)}`} className={`h-1 flex-1 rounded-full ${STATE_BG[agentState(a)]} opacity-70`} />)}
                </div>
              ) : g.agents.map((a: any) => <AgentRow key={a.id} a={a} active={a.id === current} />)}
            </div>
          );
        })}
      </nav>

      <div className="flex shrink-0 gap-2 border-t border-line p-3">
        <a className="btn btn-primary h-9 flex-1" href="#/tasks/brief">✦ Brief CEO</a>
        <a className="btn btn-primary h-9 flex-1" href="#/tasks/new">＋ New Task</a>
      </div>
    </aside>
  );
}

function AgentRow({ a, active }: { a: any; active: boolean }) {
  const fixed = a.model_mode === 'fixed';
  return (
    <a href={`#/agent/${a.id}`}
      className={`ml-4 block border-l-2 py-2 pl-4 pr-4 transition-colors ${active ? 'border-l-accent bg-raise' : 'border-l-line hover:bg-raise/50'}`}>
      <div className="flex items-center gap-2">
        <span className={`truncate text-[12.5px] ${active ? 'text-fg' : ''}`}>{a.name}</span>
        {a.level === 2 && <span className="text-[10px] text-accent" title="Department leader">★</span>}
        <span className="ml-auto" />
        {fixed && <span className="chip text-kin" title="Always runs on this model">{a.model}</span>}
        <StateDot a={a} />
      </div>
      <div className="mt-0.5 truncate text-[10.5px] text-faint">∿ {a.name === a.role ? (a.level === 3 ? 'specialist' : a.role) : a.role}</div>
      {a.current_task && <div className="mt-0.5 truncate text-[10.5px] text-kin">→ {a.current_task}</div>}
    </a>
  );
}

function Menu({ page, theme, setTheme, paused, reloadOv, onToast, onClose }:
  { page: string; theme: string; setTheme: (t: string) => void; paused: boolean; reloadOv: () => void; onToast: (s: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const c = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    addEventListener('keydown', k); setTimeout(() => addEventListener('mousedown', c));
    return () => { removeEventListener('keydown', k); removeEventListener('mousedown', c); };
  }, [onClose]);
  return (
    <div ref={ref} className="rise absolute left-3 right-3 top-14 z-40 rounded-lg border border-line-strong bg-raise p-1.5 shadow-2xl">
      {PAGES.map((p) => (
        <a key={p.id} href={`#/${p.id}`} onClick={onClose}
          className={`flex h-8 items-center rounded-md px-2.5 text-[12px] hover:bg-panel ${page === p.id ? 'text-accent' : ''}`}>
          {p.name}<span className="ml-auto rounded border border-line-strong px-1 text-[10px] text-faint">Ctrl {p.key}</span>
        </a>
      ))}
      <div className="my-1.5 border-t border-line" />
      <div className="px-2.5 pb-1 pt-0.5 text-[10px] uppercase tracking-wider text-faint">Theme</div>
      <div className="grid grid-cols-2 gap-1 px-1">
        {THEMES.map(([id, name]) => (
          <button key={id} onClick={() => setTheme(id)} className={`rounded-md border px-2 py-1.5 text-left text-[11px] ${theme === id ? 'border-accent text-accent' : 'border-line hover:border-line-strong'}`}>{name}</button>
        ))}
      </div>
      <div className="my-1.5 border-t border-line" />
      <button className="flex h-8 w-full items-center rounded-md px-2.5 text-[12px] hover:bg-panel" onClick={() => api('POST', '/api/owner/pause', { paused: !paused }).then(() => { reloadOv(); onToast(paused ? 'Organization resumed' : 'Organization paused: no new sessions start'); onClose(); })}>
        {paused ? '▶ Resume organization' : '❚❚ Pause organization'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- Center header
function CenterHeader({ agent, org, page, ov, reloadOv, onToast, right, setRight }:
  { agent: any; org: any; page: string; ov: any; reloadOv: () => void; onToast: (s: string) => void; right: boolean; setRight: (f: (r: boolean) => boolean) => void }) {
  const [confirm, setConfirm] = useState(false);
  const five = ov?.claude?.lastRateLimit?.unifiedWindows?.five_hour;
  const pct = five ? Math.round(five.utilization * 100) : null;
  const dept = agent && org?.departments.find((d: any) => d.id === agent.department_id);

  async function stopAll() {
    if (!confirm) { setConfirm(true); setTimeout(() => setConfirm(false), 3000); return; }
    setConfirm(false);
    const r = await api('POST', '/api/owner/stop-all'); onToast(`Stopped ${r.stopped} session(s)`); reloadOv();
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5">
      {agent ? (
        <div className="flex min-w-0 items-center gap-2.5">
          <StateDot a={agent} />
          <span className="truncate text-[14px] font-semibold">{agent.name}</span>
          <span className="pill text-accent">{agent.role}</span>
          {dept && <span className="hidden text-[11px] text-faint lg:inline">{dept.name}</span>}
          <span className={`chip ${agent.model_mode === 'fixed' ? 'text-kin' : 'text-ai'}`}>{agent.model_mode === 'fixed' ? agent.model : 'auto model'}</span>
          <a className="btn btn-ghost h-6 px-2 text-[11px]" href={`#/org/${agent.id}`}>profile</a>
        </div>
      ) : (
        <span className="text-[14px] font-semibold">{(PAGES.find((p) => p.id === page) ?? PAGES[0]).name}</span>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-3">
        {ov?.claude?.rateLimitedUntil && <span className="pill text-kin">limit · resumes {new Date(ov.claude.rateLimitedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
        {ov?.paused && <span className="pill text-kin">paused</span>}
        {ov?.claude?.costEstimateTodayUsd != null && <span className="pill text-matcha" title="API-equivalent estimate today; not a bill">${ov.claude.costEstimateTodayUsd.toFixed(2)}</span>}
        <div className="w-28" title={five ? `Claude 5-hour window: ${pct}%` : 'Reported after the first session runs'}>
          <div className="mb-1 text-[9.5px] font-bold tracking-wider text-dim">CLAUDE 5H {pct != null && <span className="font-normal text-faint">{pct}%</span>}</div>
          <div className="h-1 overflow-hidden rounded-full bg-line">
            <div className={`h-full rounded-full ${pct == null ? '' : pct >= 90 ? 'bg-shu' : pct >= 70 ? 'bg-kin' : 'bg-matcha'}`} style={{ width: `${pct ?? 0}%` }} />
          </div>
        </div>
        <button className="btn btn-danger" onClick={stopAll}>■ {confirm ? 'Click again' : 'Stop all'}</button>
        <button className="btn btn-ghost h-7 w-7 p-0" onClick={() => setRight((r) => !r)} title="Toggle right bar (Ctrl+.)" aria-label="Toggle right bar">{right ? '⇥' : '⇤'}</button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------- Right Bar
function RightBar({ agentId, agents }: { agentId: string | null; agents: any[] }) {
  const [tab, setTab] = useState(() => store.get('hq.rtab', 'tasks'));
  useEffect(() => store.set('hq.rtab', tab), [tab]);
  const tabs = [['tasks', 'Tasks'], ['activity', 'Activity'], ['history', 'History']];
  return (
    <aside className="flex min-h-0 flex-col border-l border-line bg-panel">
      <div className="flex h-14 shrink-0 border-b border-line">
        {tabs.map(([id, name]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`flex-1 border-b-2 text-[12px] transition-colors ${tab === id ? 'border-accent text-fg' : 'border-transparent text-dim hover:text-fg'}`}>{name}</button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'tasks' && <TasksTab agentId={agentId} agents={agents} />}
        {tab === 'activity' && <ActivityTab agentId={agentId} />}
        {tab === 'history' && <HistoryTab agentId={agentId} />}
      </div>
    </aside>
  );
}

const OPEN = ['RUNNING', 'REVIEW', 'ASSIGNED', 'FAILED', 'BLOCKED', 'PLANNED', 'BACKLOG'];
function TasksTab({ agentId, agents }: { agentId: string | null; agents: any[] }) {
  const { data } = useResource<{ tasks: any[] }>('/api/tasks', ['task', 'session.status']);
  if (!data) return <Empty>Loading…</Empty>;
  const list = data.tasks.filter((t) => (agentId ? t.assignee_id === agentId : OPEN.includes(t.status)))
    .sort((a, b) => OPEN.indexOf(a.status) - OPEN.indexOf(b.status) || a.priority - b.priority);
  if (list.length === 0) return <Empty>{agentId ? 'No tasks assigned to this agent.' : 'No open tasks.'}</Empty>;
  const who = (id: string | null) => agents.find((a) => a.id === id)?.name ?? 'Unassigned';
  return (
    <div className="space-y-2 p-3">
      <div className="px-1 text-[10.5px] uppercase tracking-wider text-faint">{agentId ? 'Assigned to this agent' : 'Open work · all agents'}</div>
      {list.map((t) => (
        <a key={t.id} href={`#/tasks/${t.id}`} className="block rounded-lg border border-line bg-ink/40 p-3 transition-colors hover:border-line-strong">
          <div className="flex items-center gap-2"><Status s={t.status} /><span className={`ml-auto text-[10px] ${t.priority <= 1 ? 'text-shu' : 'text-faint'}`}>P{t.priority}</span></div>
          <div className="mt-1 text-[12px] leading-snug">{t.title}</div>
          {!agentId && <div className="mt-1 truncate text-[10.5px] text-faint">∿ {who(t.assignee_id)}</div>}
        </a>
      ))}
    </div>
  );
}

function ActivityTab({ agentId }: { agentId: string | null }) {
  const { data } = useResource<any[]>('/api/sessions', ['session.status']);
  if (!data) return <Empty>Loading…</Empty>;
  const list = data.filter((s) => !agentId || s.agent_id === agentId).slice(0, 40);
  if (list.length === 0) return <Empty>No sessions yet.</Empty>;
  return (
    <div className="space-y-2 p-3">
      {list.map((s) => {
        const live = ['queued', 'starting', 'running'].includes(s.status);
        return (
          <a key={s.id} href={agentId ? `#/sessions/${s.id}` : `#/agent/${s.agent_id}`}
            className={`block rounded-lg border p-3 transition-colors hover:border-line-strong ${live ? 'border-kin/40' : 'border-line'} bg-ink/40`}>
            <div className="flex items-center gap-2">
              <span className={`size-1.5 rounded-full ${live ? 'bg-kin breathe' : s.status === 'completed' ? 'bg-matcha' : s.status === 'failed' || s.status === 'timeout' ? 'bg-shu' : 'bg-faint'}`} />
              <span className="truncate text-[12px] text-ai">{s.agent_name}</span>
              <span className="chip ml-auto text-accent">{s.model}</span>
            </div>
            <div className="mt-1 truncate text-[11px] text-dim">{s.task_title ?? (s.purpose === 'plan' ? 'CEO planning' : s.purpose === 'assess' ? 'Difficulty rating' : 'Follow-up')}</div>
            <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-faint">
              <Status s={s.status} /><span>{ago(s.queued_at)}</span>
              {s.cost_usd_estimate != null && <span className="ml-auto text-matcha">${s.cost_usd_estimate.toFixed(2)}</span>}
            </div>
          </a>
        );
      })}
    </div>
  );
}

function HistoryTab({ agentId }: { agentId: string | null }) {
  const { data } = useResource<any[]>('/api/audit', ['task', 'session.status', 'org', 'paused', 'project']);
  if (!data) return <Empty>Loading…</Empty>;
  const list = data.filter((a) => !agentId || a.actor === agentId || a.target === agentId || (a.details ?? '').includes(`"${agentId}"`)).slice(0, 150);
  if (list.length === 0) return <Empty>No history yet.</Empty>;
  return (
    <div className="py-2">
      {list.map((a) => (
        <div key={a.id} className="border-b border-line/50 px-4 py-2 text-[11px]">
          <div className="flex gap-2"><span className="text-accent">{a.action}</span><span className="ml-auto shrink-0 text-faint">{ago(a.created_at)}</span></div>
          <div className="mt-0.5 truncate text-faint">{a.actor} → {a.target ?? '—'}</div>
        </div>
      ))}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
