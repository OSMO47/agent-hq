import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { api, useConnected, useResource, useLive } from './api';
import Overview from './pages/Overview';
import Organization from './pages/Organization';
import Tasks from './pages/Tasks';
import Sessions from './pages/Sessions';
import Settings from './pages/Settings';

const PAGES = [
  { id: 'overview', jp: '概要', name: 'Overview', C: Overview },
  { id: 'org', jp: '組織', name: 'Organization', C: Organization },
  { id: 'tasks', jp: '任務', name: 'Tasks', C: Tasks },
  { id: 'sessions', jp: '実行', name: 'Live Sessions', C: Sessions },
  { id: 'settings', jp: '設定', name: 'Settings', C: Settings },
] as const;
// Recruitment, Agent Studio, Skills, Memory and Analytics land in later phases; they are not shown until they work.

function useHashRoute() {
  const read = () => location.hash.slice(2) || 'overview';
  const [r, setR] = useState(read);
  useEffect(() => { const f = () => setR(read()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return r;
}

function App() {
  const route = useHashRoute();
  const [page, param] = route.split('/');
  const Page = (PAGES.find((p) => p.id === page) ?? PAGES[0]).C;
  const connected = useConnected();
  const ov = useResource<any>('/api/overview', ['session.status', 'paused', 'limited', 'org'], 15000);
  const [stopping, setStopping] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  useLive((m) => { if (m.type === 'limited') setToast(`Usage limit reached — queue resumes at ${new Date(m.until).toLocaleTimeString()}`); });

  const paused = ov.data?.paused;
  const running = (ov.data?.sessions?.running ?? 0) + (ov.data?.sessions?.starting ?? 0);
  const limitedUntil = ov.data?.claude?.rateLimitedUntil;

  async function stopAll() {
    if (!confirmStop) { setConfirmStop(true); setTimeout(() => setConfirmStop(false), 3000); return; }
    setStopping(true); setConfirmStop(false);
    try { const r = await api('POST', '/api/owner/stop-all'); setToast(`Stopped ${r.stopped} session(s)`); } finally { setStopping(false); ov.reload(); }
  }

  return (
    <div className="grid h-full grid-cols-[208px_1fr] grid-rows-[48px_1fr]">
      <div className="row-span-2 flex flex-col border-r border-line bg-panel">
        <div className="flex h-12 items-center gap-2.5 border-b border-line px-4">
          <div className="grid size-6 place-items-center rounded-[5px] bg-shu font-bold text-[12px] text-ink">本</div>
          <div className="leading-tight"><div className="text-[13px] font-semibold tracking-tight">Agent HQ</div><div className="text-[10px] text-faint">Claude organization</div></div>
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          {PAGES.map((p) => {
            const active = p.id === page || (!PAGES.some((x) => x.id === page) && p.id === 'overview');
            return (
              <a key={p.id} href={`#/${p.id}`}
                className={`group flex h-8 items-center gap-3 rounded-md px-2.5 text-[12.5px] transition-colors ${active ? 'bg-raise text-fg' : 'text-dim hover:bg-raise/60 hover:text-fg'}`}>
                <span className={`w-6 text-[11px] ${active ? 'text-shu' : 'text-faint group-hover:text-dim'}`}>{p.jp}</span>{p.name}
                {p.id === 'sessions' && running > 0 && <span className="ml-auto font-mono text-[10.5px] text-matcha">{running}</span>}
              </a>
            );
          })}
        </nav>
        <div className="border-t border-line p-3 text-[11px] text-faint">
          <div className="flex items-center gap-2"><span className={`size-1.5 rounded-full ${connected ? 'bg-matcha' : 'bg-shu breathe'}`} />{connected ? 'Live · 127.0.0.1' : 'Reconnecting…'}</div>
        </div>
      </div>

      <header className="flex items-center gap-3 border-b border-line px-5">
        <div className="text-[13px] font-medium">{(PAGES.find((p) => p.id === page) ?? PAGES[0]).name}</div>
        <div className="ml-auto flex items-center gap-2">
          {limitedUntil && <span className="rounded-md border border-kin/40 px-2 py-1 text-[11px] text-kin">Usage limit · resumes {new Date(limitedUntil).toLocaleTimeString()}</span>}
          {paused && <span className="rounded-md border border-kin/40 px-2 py-1 text-[11px] text-kin">Organization paused</span>}
          <button className="btn" onClick={() => api('POST', '/api/owner/pause', { paused: !paused }).then(ov.reload)} disabled={!ov.data}>
            {paused ? 'Resume org' : 'Pause org'}
          </button>
          <button className="btn btn-danger" onClick={stopAll} disabled={stopping}>
            <span className="size-1.5 rounded-sm bg-shu" />{confirmStop ? 'Click again to stop all' : 'Stop all agents'}
          </button>
        </div>
      </header>

      <main className="min-h-0 overflow-auto">
        <Page param={param} overview={ov.data} />
      </main>

      {toast && (
        <div className="rise fixed bottom-5 right-5 z-50 flex items-center gap-3 rounded-lg border border-line-strong bg-raise px-4 py-2.5 text-[12.5px] shadow-2xl">
          {toast}<button className="text-faint hover:text-fg" onClick={() => setToast(null)}>✕</button>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
