import { useEffect, useState } from 'react';
import { api, useResource, NEXT, ago } from '../api';
import { Drawer, Empty, Kv, Status, Dot } from '../ui';

const COLUMNS = ['BACKLOG', 'PLANNED', 'ASSIGNED', 'RUNNING', 'REVIEW', 'DONE'];
const SIDE = ['BLOCKED', 'FAILED', 'CANCELLED'];
const PRIO = ['P0', 'P1', 'P2', 'P3', 'P4'];

export default function Tasks() {
  const projects = useResource<any[]>('/api/projects', ['project']);
  const org = useResource<{ agents: any[] }>('/api/org', ['org']);
  const [pid, setPid] = useState<string | null>(() => { try { return localStorage.getItem('hq.project'); } catch { return null; } });
  useEffect(() => {
    if (projects.data && (!pid || !projects.data.some((p) => p.id === pid))) setPid(projects.data[0]?.id ?? null);
  }, [projects.data, pid]);
  useEffect(() => { try { if (pid) localStorage.setItem('hq.project', pid); } catch { /* private mode */ } }, [pid]);

  const tasks = useResource<{ tasks: any[]; dependencies: any[] }>(pid ? `/api/tasks?projectId=${pid}` : null, ['task', 'session.status']);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState<'project' | 'task' | null>(null);

  const agents = org.data?.agents ?? [];
  const agentName = (id: string | null) => (id ? agents.find((a) => a.id === id)?.role ?? id : 'Unassigned');
  const all = tasks.data?.tasks ?? [];
  const status = Object.fromEntries(all.map((t) => [t.id, t.status]));
  const deps = (id: string) => (tasks.data?.dependencies ?? []).filter((d) => d.task_id === id).map((d) => d.depends_on);
  const blocked = (id: string) => deps(id).some((d) => status[d] !== 'DONE');

  if (!projects.data) return <Empty>Loading…</Empty>;
  if (projects.data.length === 0 && creating !== 'project') {
    return <Empty><div className="space-y-3"><div>No projects yet.</div><button className="btn btn-primary" onClick={() => setCreating('project')}>Create first project</button></div></Empty>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-5">
        <select className="field w-56" value={pid ?? ''} onChange={(e) => setPid(e.target.value)}>
          {projects.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button className="btn" onClick={() => setCreating('project')}>New project</button>
        <div className="ml-auto flex items-center gap-3 text-[11.5px] text-faint">
          {SIDE.map((s) => <span key={s}><Status s={s} /> {all.filter((t) => t.status === s).length}</span>)}
          <button className="btn btn-primary" disabled={!pid} onClick={() => setCreating('task')}>New task</button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-6 gap-3 overflow-x-auto p-4">
        {COLUMNS.map((col) => {
          const items = all.filter((t) => t.status === col || (col === 'BACKLOG' && SIDE.includes(t.status)));
          return (
            <div key={col} className="flex min-h-0 min-w-[200px] flex-col rounded-lg bg-panel/60">
              <div className="flex h-9 items-center justify-between px-3"><Status s={col} /><span className="font-mono text-[10.5px] text-faint">{items.length}</span></div>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                {items.map((t) => (
                  <button key={t.id} onClick={() => setOpenId(t.id)}
                    className="rise block w-full rounded-md border border-line bg-panel p-3 text-left transition-colors hover:border-line-strong">
                    <div className="flex items-start gap-2">
                      <span className={`mt-px font-mono text-[10px] ${t.priority <= 1 ? 'text-shu' : 'text-faint'}`}>{PRIO[t.priority]}</span>
                      <span className="text-[12.5px] leading-snug">{t.title}</span>
                    </div>
                    <div className="mt-2 flex items-center gap-1.5 text-[11px] text-dim">
                      {t.status === 'RUNNING' && <Dot status="running" />}
                      <span className="truncate">{agentName(t.assignee_id)}</span>
                      {SIDE.includes(t.status) && <span className="ml-auto"><Status s={t.status} /></span>}
                      {!SIDE.includes(t.status) && blocked(t.id) && <span className="ml-auto text-[10.5px] text-kin">waiting on deps</span>}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {creating === 'project' && <NewProject onDone={(id) => { setCreating(null); projects.reload(); if (id) setPid(id); }} />}
      {creating === 'task' && pid && <NewTask projectId={pid} agents={agents} tasks={all} onDone={() => { setCreating(null); tasks.reload(); }} />}
      {openId && <TaskDrawer id={openId} agents={agents} allTasks={all} onClose={() => setOpenId(null)} onChange={tasks.reload} />}
    </div>
  );
}

function NewProject({ onDone }: { onDone: (id?: string) => void }) {
  const [name, setName] = useState(''); const [desc, setDesc] = useState(''); const [repo, setRepo] = useState(''); const [err, setErr] = useState('');
  return (
    <Drawer open onClose={() => onDone()} title="New project">
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault();
        try { const p = await api('POST', '/api/projects', { name, description: desc, repoPath: repo || null }); onDone(p.id); } catch (x) { setErr((x as Error).message); }
      }}>
        <label className="block space-y-1"><span className="label">Name</span><input className="field" value={name} onChange={(e) => setName(e.target.value)} autoFocus required /></label>
        <label className="block space-y-1"><span className="label">Description</span><textarea className="field" rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
        <label className="block space-y-1"><span className="label">Workspace folder (optional)</span>
          <input className="field font-mono" placeholder="Leave empty → agent-hq/data/workspaces/<project>" value={repo} onChange={(e) => setRepo(e.target.value)} />
          <span className="block text-[11px] text-faint">Agents can only work inside this folder.</span></label>
        {err && <div className="text-[12px] text-shu">{err}</div>}
        <button className="btn btn-primary">Create project</button>
      </form>
    </Drawer>
  );
}

function NewTask({ projectId, agents, tasks, onDone }: { projectId: string; agents: any[]; tasks: any[]; onDone: () => void }) {
  const [f, setF] = useState({ title: '', description: '', assigneeId: '', priority: 2, dependsOn: [] as string[] });
  const [err, setErr] = useState('');
  return (
    <Drawer open onClose={onDone} title="New task">
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault();
        try { await api('POST', '/api/tasks', { projectId, ...f, assigneeId: f.assigneeId || undefined }); onDone(); } catch (x) { setErr((x as Error).message); }
      }}>
        <label className="block space-y-1"><span className="label">Title</span><input className="field" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus required /></label>
        <label className="block space-y-1"><span className="label">Instructions for the agent</span><textarea className="field" rows={6} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1"><span className="label">Assignee</span><AgentSelect agents={agents} value={f.assigneeId} onChange={(v) => setF({ ...f, assigneeId: v })} /></label>
          <label className="block space-y-1"><span className="label">Priority</span>
            <select className="field" value={f.priority} onChange={(e) => setF({ ...f, priority: Number(e.target.value) })}>{PRIO.map((p, i) => <option key={p} value={i}>{p}</option>)}</select></label>
        </div>
        {tasks.length > 0 && <label className="block space-y-1"><span className="label">Depends on</span>
          <select multiple className="field h-28 py-1" value={f.dependsOn} onChange={(e) => setF({ ...f, dependsOn: [...e.target.selectedOptions].map((o) => o.value) })}>
            {tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select></label>}
        {err && <div className="text-[12px] text-shu">{err}</div>}
        <button className="btn btn-primary">Create task</button>
      </form>
    </Drawer>
  );
}

function AgentSelect({ agents, value, onChange }: { agents: any[]; value: string; onChange: (v: string) => void }) {
  return (
    <select className="field" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Unassigned</option>
      {[1, 2, 3].map((lvl) => (
        <optgroup key={lvl} label={['', 'Executive', 'Leaders', 'Specialists'][lvl]}>
          {agents.filter((a) => a.level === lvl && a.status === 'active').map((a) => <option key={a.id} value={a.id}>{a.level === 3 ? a.role : `${a.name} · ${a.role}`}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

function TaskDrawer({ id, agents, allTasks, onClose, onChange }: { id: string; agents: any[]; allTasks: any[]; onClose: () => void; onChange: () => void }) {
  const { data, reload } = useResource<any>(`/api/tasks/${id}`, ['task', 'session.status']);
  const [err, setErr] = useState(''); const [note, setNote] = useState('');
  const act = async (fn: () => Promise<unknown>) => { setErr(''); try { await fn(); reload(); onChange(); } catch (e) { setErr((e as Error).message); } };
  const t = data?.task;
  const title = (tid: string) => allTasks.find((x) => x.id === tid)?.title ?? tid;

  return (
    <Drawer open onClose={onClose} title={t?.title ?? '…'}>
      {!t ? <Empty>Loading…</Empty> : (
        <div className="space-y-5">
          <div>
            <Kv k="Status"><Status s={t.status} /></Kv>
            <Kv k="Assignee"><AgentSelect agents={agents} value={t.assignee_id ?? ''} onChange={(v) => act(() => api('PATCH', `/api/tasks/${id}`, { assigneeId: v }))} /></Kv>
            <Kv k="Priority">{PRIO[t.priority]}</Kv>
            <Kv k="Attempts">{t.attempts}</Kv>
            <Kv k="Review">{t.review_status ?? '—'}</Kv>
            <Kv k="Depends on">{data.dependsOn.length === 0 ? '—' : data.dependsOn.map((d: any) => (
              <div key={d.id} className="flex items-center gap-2"><Status s={d.status} /><span>{title(d.id)}</span></div>))}</Kv>
          </div>
          {t.description && <p className="whitespace-pre-wrap rounded-md border border-line bg-ink p-3 text-[12.5px] leading-relaxed text-dim">{t.description}</p>}

          <div className="flex flex-wrap gap-2">
            {t.status === 'ASSIGNED' && <button className="btn btn-primary" onClick={() => act(() => api('POST', `/api/tasks/${id}/run`))}>▶ Run with Claude</button>}
            {t.status === 'RUNNING' && t.lock_session && <>
              <a className="btn" href={`#/sessions/${t.lock_session}`}>Watch live</a>
              <button className="btn btn-danger" onClick={() => act(() => api('POST', `/api/sessions/${t.lock_session}/stop`))}>Stop</button>
            </>}
            {t.status === 'REVIEW' && <button className="btn btn-primary" onClick={() => act(() => api('POST', `/api/tasks/${id}/transition`, { to: 'DONE' }))}>Approve → Done</button>}
            {NEXT[t.status].filter((s) => !(t.status === 'REVIEW' && s === 'DONE')).map((s) => (
              <button key={s} className={`btn ${s === 'CANCELLED' || s === 'FAILED' ? 'btn-danger' : ''}`}
                onClick={() => act(() => api('POST', `/api/tasks/${id}/transition`, { to: s, note: s === 'ASSIGNED' && t.status === 'REVIEW' ? note : undefined }))}>
                {t.status === 'REVIEW' && s === 'ASSIGNED' ? 'Request changes' : `→ ${s}`}
              </button>
            ))}
          </div>
          {t.status === 'REVIEW' && <textarea className="field" rows={2} placeholder="Feedback for 'Request changes' (sent to the agent on the next run)" value={note} onChange={(e) => setNote(e.target.value)} />}
          {err && <div className="text-[12px] text-shu">{err}</div>}

          {data.sessions.length > 0 && <div>
            <div className="label mb-2">Sessions</div>
            {data.sessions.map((s: any) => (
              <a key={s.id} href={`#/sessions/${s.id}`} className="flex items-center gap-2 border-b border-line/60 py-1.5 text-[12px] hover:text-fg">
                <Dot status={s.status} /><span className="font-mono text-[11px] text-dim">{s.id}</span><Status s={s.status} /><span className="ml-auto text-faint">{ago(s.queued_at)}</span>
              </a>
            ))}
          </div>}

          <div>
            <div className="label mb-2">Comments & reports</div>
            {data.comments.length === 0 && <div className="text-[12px] text-faint">None yet.</div>}
            {data.comments.map((c: any) => (
              <div key={c.id} className="mb-2 rounded-md border border-line p-3">
                <div className="mb-1 flex justify-between text-[11px] text-faint"><span>{c.author === 'owner' ? 'Owner' : agents.find((a) => a.id === c.author)?.role ?? c.author}</span><span>{ago(c.created_at)}</span></div>
                <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed">{c.body}</div>
              </div>
            ))}
            <CommentBox onSend={(body) => act(() => api('POST', `/api/tasks/${id}/comments`, { body }))} />
          </div>

          <div>
            <div className="label mb-2">History</div>
            {data.history.map((h: any) => (
              <div key={h.id} className="flex gap-3 py-1 font-mono text-[11px] text-dim">
                <span className="w-14 text-faint">{ago(h.created_at)}</span><span>{h.from_status ?? '∅'} → {h.to_status}</span><span className="text-faint">{h.actor}</span>
                <span className="truncate text-faint">{h.note}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Drawer>
  );
}

function CommentBox({ onSend }: { onSend: (b: string) => void }) {
  const [v, setV] = useState('');
  return (
    <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (v.trim()) { onSend(v.trim()); setV(''); } }}>
      <input className="field" placeholder="Add a note for the agent…" value={v} onChange={(e) => setV(e.target.value)} />
      <button className="btn">Add</button>
    </form>
  );
}
