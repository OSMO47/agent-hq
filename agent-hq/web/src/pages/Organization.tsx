import { useEffect, useState } from 'react';
import { api, useResource, MODELS } from '../api';
import { Dot, Drawer, Empty, Kv, Status } from '../ui';

type Agent = { id: string; name: string; role: string; level: number; department_id: string | null; reports_to: string | null; model: string; model_mode: 'difficulty' | 'fixed';
  instructions: string; permissions: string; status: string; session_id: string | null; session_status: string | null; current_task: string | null };

const agentState = (a: Agent) => (a.status !== 'active' ? a.status : a.session_status ?? 'idle');

function AgentChip({ a, onOpen, big }: { a: Agent; onOpen: (a: Agent) => void; big?: boolean }) {
  const st = agentState(a);
  return (
    <button onClick={() => onOpen(a)}
      className={`group w-full rounded-lg border text-left transition-colors hover:border-line-strong hover:bg-raise ${big ? 'border-line-strong bg-raise/60 px-3.5 py-3' : 'border-transparent px-2.5 py-2'}`}>
      <div className="flex items-center gap-2">
        <Dot status={st} />
        <span className={`truncate ${big ? 'text-[13px] font-medium' : 'text-[12.5px]'}`}>{a.level === 3 ? a.role : a.name}</span>
        <span className={`ml-auto font-mono text-[10px] ${a.model_mode === 'fixed' ? 'text-kin' : 'text-faint'}`} title={a.model_mode === 'fixed' ? 'Always this model' : 'Model by task difficulty'}>
          {a.model_mode === 'fixed' ? a.model : 'auto'}
        </span>
      </div>
      {big && <div className="mt-0.5 truncate pl-3.5 text-[11.5px] text-dim">{a.role}</div>}
      {a.current_task && <div className="mt-1 truncate pl-3.5 text-[11px] text-matcha">→ {a.current_task}</div>}
      {a.status !== 'active' && <div className="mt-1 pl-3.5 text-[11px] text-shu">{a.status}</div>}
    </button>
  );
}

export default function Organization({ param }: { param?: string }) {
  const { data, reload } = useResource<{ departments: any[]; agents: Agent[] }>('/api/org', ['session.status', 'org']);
  const [sel, setSel] = useState<Agent | null>(param ? ({ id: param } as Agent) : null);
  const [err, setErr] = useState<string | null>(null);
  // #/org/<agentId> (e.g. the header 'profile' link) opens that agent, every time the link changes.
  useEffect(() => { setSel(param ? ({ id: param } as Agent) : null); }, [param]);
  if (!data) return <Empty>Loading…</Empty>;

  const ceo = data.agents.find((a) => a.level === 1);
  const byId = Object.fromEntries(data.agents.map((a) => [a.id, a]));
  const current = sel ? byId[sel.id] ?? sel : null;

  async function patch(body: object) {
    if (!current) return;
    setErr(null);
    try { await api('PATCH', `/api/agents/${current.id}`, body); reload(); } catch (e) { setErr((e as Error).message); }
  }

  return (
    <div className="p-5">
      {ceo && (
        <div className="mx-auto mb-2 w-72"><AgentChip a={ceo} onOpen={setSel} big /></div>
      )}
      <div className="mx-auto h-5 w-px bg-line-strong" />
      <div className="relative grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3 border-t border-line-strong pt-5">
        {data.departments.map((d) => {
          const leader = byId[d.leader_id];
          const team = data.agents.filter((a) => a.level === 3 && a.department_id === d.id);
          const busy = team.filter((a) => a.session_status).length + (leader?.session_status ? 1 : 0);
          return (
            <div key={d.id} className="card rise flex flex-col">
              <div className="flex items-baseline justify-between px-3.5 pt-3">
                <span className="label">{d.name}</span>
                <span className="font-mono text-[10.5px] text-faint">{busy}/{team.length + 1} busy</span>
              </div>
              <div className="p-2">{leader && <AgentChip a={leader} onOpen={setSel} big />}</div>
              <div className="mx-2 mb-2 border-l border-line pl-1.5">
                {team.map((a) => <AgentChip key={a.id} a={a} onOpen={setSel} />)}
                {team.length === 0 && <div className="px-2.5 py-2 text-[11.5px] text-faint">No specialists</div>}
              </div>
            </div>
          );
        })}
      </div>

      <Drawer open={!!current} onClose={() => { setSel(null); setErr(null); if (param) location.hash = '#/org'; }}
        title={current && <span className="flex items-center gap-2"><Dot status={agentState(current)} />{current.name}<span className="text-dim">· {current.role}</span></span>}>
        {current && (() => {
          const perm = JSON.parse(current.permissions || '{}');
          return (
            <div className="space-y-5">
              <div>
                <Kv k="ID"><span className="font-mono text-[11.5px]">{current.id}</span></Kv>
                <Kv k="Level">{['', 'CEO', 'Department leader', 'Specialist'][current.level]}</Kv>
                <Kv k="Reports to">{current.reports_to ? byId[current.reports_to]?.name ?? current.reports_to : 'Owner'}</Kv>
                <Kv k="State"><Status s={agentState(current)} /></Kv>
                <Kv k="Current task">{current.current_task ?? '—'}</Kv>
                {current.session_id && <Kv k="Session"><a className="font-mono text-[11.5px] text-ai hover:underline" href={`#/sessions/${current.session_id}`}>{current.session_id}</a></Kv>}
              </div>
              <div>
                <div className="label mb-2">Model choice</div>
                <div className="mb-3 inline-flex rounded-md border border-line-strong bg-ink p-0.5">
                  {([['difficulty', 'By task difficulty'], ['fixed', 'Always this model']] as const).map(([m, label]) => (
                    <button key={m} onClick={() => current.model_mode !== m && patch({ modelMode: m })}
                      className={`h-6 rounded-[5px] px-2.5 text-[12px] ${current.model_mode === m ? 'bg-fg font-medium text-ink' : 'text-dim hover:text-fg'}`}>{label}</button>
                  ))}
                </div>
                <div className="mb-2 text-[11.5px] text-faint">
                  {current.model_mode === 'fixed'
                    ? 'Every task for this agent runs on the model below — no assessment, no escalation.'
                    : 'Difficulty (set by you or rated by the department leader) picks the model; it moves up if the work is harder than expected. The model below is only a fallback.'}
                </div>
                <div className="flex gap-1.5">
                  {MODELS.map((m) => (
                    <button key={m} className={`btn ${current.model === m ? 'btn-primary' : ''}`} onClick={() => patch({ model: m })}>{m}</button>
                  ))}
                </div>
              </div>
              <div>
                <div className="label mb-2">Tools</div>
                <div className="flex flex-wrap gap-1">{(perm.tools ?? ['default']).map((t: string) => <span key={t} className="rounded border border-line px-1.5 py-0.5 font-mono text-[10.5px] text-dim">{t}</span>)}</div>
                <div className="label mb-2 mt-3">Auto-approved</div>
                <div className="flex flex-wrap gap-1">{(perm.allowedTools ?? []).map((t: string) => <span key={t} className="rounded border border-matcha/30 px-1.5 py-0.5 font-mono text-[10.5px] text-matcha">{t}</span>)}</div>
                {perm.disallowedTools?.length > 0 && <>
                  <div className="label mb-2 mt-3">Always denied</div>
                  <div className="flex flex-wrap gap-1">{perm.disallowedTools.map((t: string) => <span key={t} className="rounded border border-shu/30 px-1.5 py-0.5 font-mono text-[10.5px] text-shu">{t}</span>)}</div>
                </>}
              </div>
              <div>
                <div className="label mb-2">Instructions</div>
                <p className="whitespace-pre-wrap rounded-md border border-line bg-ink p-3 text-[12px] leading-relaxed text-dim">{current.instructions}</p>
              </div>
              {err && <div className="text-[12px] text-shu">{err}</div>}
              <div className="flex gap-2 border-t border-line pt-4">
                {current.status === 'active'
                  ? <button className="btn btn-danger" onClick={() => patch({ status: 'suspended' })}>Suspend agent</button>
                  : <button className="btn btn-primary" onClick={() => patch({ status: 'active' })}>Activate agent</button>}
              </div>
            </div>
          );
        })()}
      </Drawer>
    </div>
  );
}
