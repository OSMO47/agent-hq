import { useEffect, useState } from 'react';
import { api, useResource, NEXT, ago } from '../api';
import { Drawer, Empty, Kv, Status, Dot } from '../ui';

const COLUMNS = ['BACKLOG', 'PLANNED', 'ASSIGNED', 'RUNNING', 'REVIEW', 'DONE'];
const SIDE = ['BLOCKED', 'FAILED', 'CANCELLED'];
const PRIO = ['P0', 'P1', 'P2', 'P3', 'P4'];
const DIFFS = [['easy', 'ง่าย'], ['medium', 'กลาง'], ['hard', 'ยาก']] as const;
const DIFF_OPTIONS: [string, string][] = [['', 'หัวหน้าประเมิน'], ...DIFFS];
const DIFF_TONE: Record<string, string> = { easy: 'text-matcha border-matcha/30', medium: 'text-ai border-ai/30', hard: 'text-shu border-shu/30' };

/** Model a task will run on: difficulty → policy map; otherwise the assignee's own model. */
function useModelFor(agents: any[]) {
  const pol = useResource<any[]>('/api/policies', []);
  const map = pol.data?.find((p) => p.key === 'models.byDifficulty')?.value ?? { easy: 'haiku', medium: 'sonnet', hard: 'opus' };
  /** Mirrors server modelFor(): fixed agents → own model; difficulty → map; none → leader will assess (null). */
  return (t: { difficulty?: string | null; assignee_id?: string | null }) => {
    const a = agents.find((x) => x.id === t.assignee_id);
    if (a?.model_mode === 'fixed') return a.model;
    return t.difficulty ? map[t.difficulty] : null;
  };
}

function DiffBadge({ t, agents, model }: { t: any; agents: any[]; model: string | null }) {
  const fixed = agents.find((a) => a.id === t.assignee_id)?.model_mode === 'fixed';
  const d = t.difficulty;
  const label = fixed ? 'fixed' : d ?? 'leader assesses';
  const tone = fixed ? 'border-kin/30 text-kin' : d ? DIFF_TONE[d] : 'border-line text-faint';
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] ${tone}`}>
      {label}{model && <span className="font-mono opacity-70">· {model}</span>}
    </span>
  );
}

export default function Tasks({ param }: { param?: string }) {
  const projects = useResource<any[]>('/api/projects', ['project']);
  const org = useResource<{ agents: any[] }>('/api/org', ['org']);
  const [pid, setPid] = useState<string | null>(() => { try { return localStorage.getItem('hq.project'); } catch { return null; } });
  useEffect(() => {
    if (projects.data && (!pid || !projects.data.some((p) => p.id === pid))) setPid(projects.data[0]?.id ?? null);
  }, [projects.data, pid]);
  useEffect(() => { try { if (pid) localStorage.setItem('hq.project', pid); } catch { /* private mode */ } }, [pid]);

  const tasks = useResource<{ tasks: any[]; dependencies: any[] }>(pid ? `/api/tasks?projectId=${pid}` : null, ['task', 'session.status']);
  const [openId, setOpenId] = useState<string | null>(null);
  // Deep links from the Left/Right bars: #/tasks/brief, #/tasks/new, #/tasks/<taskId>
  useEffect(() => {
    if (param === 'brief') setCreating('brief');
    else if (param === 'new') setCreating('task');
    else if (param) api('GET', `/api/tasks/${param}`).then((r) => { setPid(r.task.project_id); setOpenId(param); }).catch(() => {});
  }, [param]);
  const clearLink = () => { if (param) location.hash = '#/tasks'; };
  const [creating, setCreating] = useState<'project' | 'task' | 'brief' | 'delete' | null>(null);
  const pstat = useResource<any>(pid ? `/api/projects/${pid}/status` : null, ['project', 'task', 'session.status', 'paused']);
  const [runMsg, setRunMsg] = useState('');

  const agents = org.data?.agents ?? [];
  const modelFor = useModelFor(agents);
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
        <button className="btn btn-ghost" disabled={!pid} onClick={() => setCreating('delete')} title="Delete this project from Agent HQ">Delete project</button>
        <div className="ml-auto flex items-center gap-3 text-[11.5px] text-faint">
          {SIDE.map((s) => <span key={s} className="whitespace-nowrap"><Status s={s} /> {all.filter((t) => t.status === s).length}</span>)}
          {pstat.data?.planning && <a className="flex items-center gap-1.5 text-kin" href={`#/sessions/${pstat.data.planning.id}`}><Dot status="running" />CEO planning…</a>}
          {runMsg && <span className="text-dim">{runMsg}</span>}
          <button className="btn" disabled={!pid || !pstat.data?.ready || pstat.data?.paused} title={pstat.data?.paused ? 'Organization is paused' : 'Start every assigned task whose dependencies are done'}
            onClick={async () => {
              try { const r = await api('POST', `/api/projects/${pid}/run-ready`); setRunMsg(`Started ${r.started}${r.errors.length ? ` · ${r.errors.length} error(s)` : ''}`); }
              catch (e) { setRunMsg((e as Error).message); }
              tasks.reload(); setTimeout(() => setRunMsg(''), 6000);
            }}>▶ Run ready ({pstat.data?.ready ?? 0})</button>
          <button className="btn" disabled={!pid} onClick={() => setCreating('task')}>New task</button>
          <button className="btn btn-primary" disabled={!pid} onClick={() => setCreating('brief')}>Brief the CEO</button>
        </div>
      </div>

      {pstat.data?.paused && (
        <div className="flex shrink-0 items-center gap-3 border-b border-kin/30 bg-kin/10 px-5 py-2 text-[12px] text-kin">
          ❚❚ Organization is paused: tasks can be created but no agent will start.
          <button className="btn h-6 text-[11px]" onClick={() => api('POST', '/api/owner/pause', { paused: false }).then(pstat.reload)}>▶ Resume</button>
        </div>
      )}
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
                    <div className="mt-2"><DiffBadge t={t} agents={agents} model={modelFor(t)} /></div>
                    <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-dim">
                      {t.status === 'RUNNING' && <Dot status="running" />}
                      <span className="truncate">{agentName(t.assignee_id)}</span>
                      {SIDE.includes(t.status) && <span className="ml-auto"><Status s={t.status} /></span>}
                      {!SIDE.includes(t.status) && blocked(t.id) && <span className="ml-auto text-[10.5px] text-kin">waiting on deps</span>}
                      {!t.assignee_id && ['BACKLOG', 'PLANNED'].includes(t.status) && <span className="ml-auto text-[10.5px] text-kin">needs assignee</span>}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {creating === 'delete' && pid && <DeleteProject id={pid} onDone={(deleted) => { setCreating(null); if (deleted) { setPid(null); projects.reload(); } }} />}
      {creating === 'project' && <NewProject onDone={(id) => { setCreating(null); projects.reload(); if (id) setPid(id); }} />}
      {creating === 'brief' && pid && <CeoBrief status={pstat.data} reload={pstat.reload} projectId={pid} onClose={() => { setCreating(null); clearLink(); }} />}
      {creating === 'task' && pid && <NewTask projectId={pid} agents={agents} tasks={all} onDone={() => { setCreating(null); tasks.reload(); clearLink(); }} />}
      {openId && <TaskDrawer id={openId} agents={agents} allTasks={all} onClose={() => { setOpenId(null); clearLink(); }} onChange={tasks.reload} />}
    </div>
  );
}

/** Confirm panel: shows exactly what is removed; the workspace folder on disk is never touched. */
function DeleteProject({ id, onDone }: { id: string; onDone: (deleted: boolean) => void }) {
  const { data, error } = useResource<any>(`/api/projects/${id}/footprint`, []);
  const [typed, setTyped] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const name = data?.project.name ?? '';
  return (
    <Drawer open onClose={() => onDone(false)} title="Delete project">
      {!data ? <Empty>{error ?? 'Loading…'}</Empty> : (
        <div className="space-y-4">
          <div className="text-[13px]">{name}</div>
          <div className="rounded-md border border-shu/40 p-3 text-[12px] leading-relaxed">
            Removes from Agent HQ: <span className="text-shu">{data.tasks} task(s)</span> with their comments and history,
            and <span className="text-shu">{data.sessions} session(s)</span> with their transcripts. This cannot be undone.
          </div>
          <div className="rounded-md border border-matcha/30 p-3 text-[12px] leading-relaxed text-matcha">
            Files are not touched: <span className="break-all font-mono text-[11px]">{data.project.repo_path ?? 'agent-hq/data/workspaces/' + id}</span> stays exactly as it is.
          </div>
          {data.liveSessions > 0 && <div className="text-[12px] text-kin">{data.liveSessions} session(s) of this project are running or queued. Stop them first.</div>}
          <label className="block space-y-1"><span className="label">Type the project name to confirm</span>
            <input className="field" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={name} autoFocus /></label>
          {err && <div className="text-[12px] text-shu">{err}</div>}
          <button className="btn btn-danger" disabled={busy || typed.trim() !== name.trim() || data.liveSessions > 0}
            onClick={async () => { setBusy(true); setErr(''); try { await api('DELETE', `/api/projects/${id}`); onDone(true); } catch (x) { setErr((x as Error).message); setBusy(false); } }}>
            Delete project
          </button>
        </div>
      )}
    </Drawer>
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

/** Owner → CEO: write a brief, the CEO reads the workspace (read-only) and turns it into tasks on this board. */
function CeoBrief({ projectId, status, reload, onClose }: { projectId: string; status: any; reload: () => void; onClose: () => void }) {
  const [text, setText] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const planning = status?.planning;
  const dirty = status?.git?.files > 0;
  const thread = [...(status?.messages ?? [])].reverse();
  return (
    <Drawer open onClose={onClose} title="Brief the CEO">
      <div className="space-y-4">
        <p className="text-[12px] leading-relaxed text-dim">
          Describe what you want. The CEO reads the project files (read-only), then creates 2–8 tasks with assignees and dependencies.
          Department leaders rate difficulty when each task runs; nothing runs until you press <span className="text-fg">Run</span>.
        </p>
        <div className="truncate font-mono text-[11px] text-faint" title={status?.workspace}>{status?.workspace}</div>
        {status && status.git === null && <div className="rounded-md border border-line px-3 py-2 text-[11.5px] text-faint">Workspace is not a git repository — agent edits cannot be reviewed or reverted with git.</div>}
        {dirty && <div className="rounded-md border border-kin/30 px-3 py-2 text-[11.5px] text-kin">{status.git.files} uncommitted change(s) in the workspace. Commit them first so agent edits are easy to review.</div>}

        {thread.length > 0 && <div className="space-y-2">
          {thread.map((m: any) => (
            <div key={m.id} className={`rounded-md border p-3 ${m.from_id === 'owner' ? 'border-line bg-ink' : 'border-ai/30'}`}>
              <div className="mb-1 flex justify-between text-[11px] text-faint"><span>{m.from_id === 'owner' ? 'You → CEO' : 'CEO → You'}</span><span>{ago(m.created_at)}</span></div>
              <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed">{m.body}</div>
            </div>
          ))}
        </div>}

        {planning ? (
          <div className="flex items-center gap-2 rounded-md border border-kin/30 px-3 py-2 text-[12px] text-kin">
            <Dot status="running" /> The CEO is reading the project and planning ({planning.status}).
            <a className="ml-auto underline" href={`#/sessions/${planning.id}`}>Watch live</a>
          </div>
        ) : (
          <form className="space-y-3" onSubmit={async (e) => {
            e.preventDefault(); setErr(''); setBusy(true);
            try { await api('POST', `/api/projects/${projectId}/brief`, { text }); setText(''); reload(); } catch (x) { setErr((x as Error).message); }
            setBusy(false);
          }}>
            <textarea className="field" rows={7} autoFocus required value={text} onChange={(e) => setText(e.target.value)}
              placeholder="e.g. Add a dark-mode toggle to the settings page and remember the choice between visits." />
            {err && <div className="text-[12px] text-shu">{err}</div>}
            <button className="btn btn-primary" disabled={busy || !text.trim() || status?.paused}>{status?.paused ? 'Organization paused' : 'Send to CEO'}</button>
          </form>
        )}
      </div>
    </Drawer>
  );
}

function NewTask({ projectId, agents, tasks, onDone }: { projectId: string; agents: any[]; tasks: any[]; onDone: () => void }) {
  const [f, setF] = useState({ title: '', description: '', assigneeId: '', priority: 2, difficulty: '', dependsOn: [] as string[] });
  const modelFor = useModelFor(agents);
  const assignee = agents.find((a) => a.id === f.assigneeId);
  const fixed = assignee?.model_mode === 'fixed';
  const [err, setErr] = useState('');
  return (
    <Drawer open onClose={onDone} title="New task">
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api('POST', '/api/tasks', { projectId, ...f, assigneeId: f.assigneeId || undefined, difficulty: f.difficulty || undefined });
          onDone();
        } catch (x) { setErr((x as Error).message); }
      }}>
        <label className="block space-y-1"><span className="label">Title</span><input className="field" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus required /></label>
        <label className="block space-y-1"><span className="label">Instructions for the agent</span><textarea className="field" rows={6} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1"><span className="label">Assignee</span><AgentSelect agents={agents} value={f.assigneeId} emptyLabel="Auto: CEO decides" onChange={(v) => setF({ ...f, assigneeId: v })} /></label>
          <label className="block space-y-1"><span className="label">Priority</span>
            <select className="field" value={f.priority} onChange={(e) => setF({ ...f, priority: Number(e.target.value) })}>{PRIO.map((p, i) => <option key={p} value={i}>{p}</option>)}</select></label>
        </div>
        <div className="space-y-1"><span className="label">Difficulty → model</span>
          {fixed ? (
            <div className="rounded-md border border-kin/30 px-3 py-2 text-[12px] text-kin">
              {assignee.role} always runs on <span className="font-mono">{assignee.model}</span> — difficulty does not apply.
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {DIFF_OPTIONS.map(([d, th]) => (
                <button type="button" key={d || 'auto'} onClick={() => setF({ ...f, difficulty: d })}
                  className={`rounded-md border px-3 py-2 text-left transition-colors ${f.difficulty === d ? (d ? DIFF_TONE[d] : 'border-fg/40 text-fg') + ' bg-raise' : 'border-line text-dim hover:border-line-strong'}`}>
                  <div className="text-[12.5px] capitalize">{d || 'auto'} <span className="text-faint">{th}</span></div>
                  <div className="font-mono text-[10.5px] text-faint">{d ? modelFor({ difficulty: d }) : 'leader rates it'}</div>
                </button>
              ))}
            </div>
          )}
          {!fixed && <div className="text-[11px] text-faint">If the agent finds it harder than expected, it moves up a level and continues the same conversation.</div>}
        </div>
        {tasks.length > 0 && <label className="block space-y-1"><span className="label">Depends on</span>
          <select multiple className="field h-28 py-1" value={f.dependsOn} onChange={(e) => setF({ ...f, dependsOn: [...e.target.selectedOptions].map((o) => o.value) })}>
            {tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select></label>}
        {err && <div className="text-[12px] text-shu">{err}</div>}
        <div className="rounded-md border border-matcha/30 px-3 py-2 text-[11.5px] leading-relaxed text-matcha">✈ Autopilot: leave Assignee on Auto and the CEO picks who does it. Work starts by itself and routine results are approved automatically. You are asked only when an agent needs your decision (Inbox). Local files only: deploy and git push are blocked.</div>
        <button className="btn btn-primary">Create task</button>
      </form>
    </Drawer>
  );
}

function AgentSelect({ agents, value, onChange, emptyLabel = 'Unassigned' }: { agents: any[]; value: string; onChange: (v: string) => void; emptyLabel?: string }) {
  return (
    <select className="field" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{emptyLabel}</option>
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
  const modelFor = useModelFor(agents);
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
            <Kv k="Difficulty">
              <div className="flex items-center gap-1.5">
                {DIFFS.map(([d]) => (
                  <button key={d} disabled={t.status === 'RUNNING'} onClick={() => act(() => api('PATCH', `/api/tasks/${id}`, { difficulty: d }))}
                    className={`rounded border px-2 py-0.5 text-[11.5px] capitalize disabled:opacity-40 ${t.difficulty === d ? DIFF_TONE[d] + ' bg-raise' : 'border-line text-dim hover:text-fg'}`}>{d}</button>
                ))}
                <span className="ml-1 font-mono text-[11px] text-faint">→ {modelFor(t) ?? 'leader assesses on run'}</span>
              </div>
            </Kv>
            <Kv k="Attempts">{t.attempts}</Kv>
            <Kv k="Review">{t.review_status ?? '—'}</Kv>
            <Kv k="Depends on">{data.dependsOn.length === 0 ? '—' : data.dependsOn.map((d: any) => (
              <div key={d.id} className="flex items-center gap-2"><Status s={d.status} /><span>{title(d.id)}</span></div>))}</Kv>
          </div>
          {t.description && <p className="whitespace-pre-wrap rounded-md border border-line bg-ink p-3 text-[12.5px] leading-relaxed text-dim">{t.description}</p>}

          <div className="flex flex-wrap gap-2">
            {!t.assignee_id && ['BACKLOG', 'PLANNED', 'BLOCKED'].includes(t.status) && <div className="w-full text-[12px] text-kin">Autopilot: the CEO is choosing who does this. You can also pick an Assignee yourself.</div>}
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
