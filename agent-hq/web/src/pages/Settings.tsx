import { useState } from 'react';
import { api, useResource, ago, MODELS } from '../api';
import { Empty, Section } from '../ui';

const FIELDS: { key: string; label: string; hint: string; kind: 'int' | 'minutes' | 'bool' | 'model' }[] = [
  { key: 'runtime.maxConcurrentSessions', label: 'Max concurrent sessions', hint: 'Claude processes running at once. Each uses RAM and plan quota.', kind: 'int' },
  { key: 'runtime.sessionTimeoutMs', label: 'Session timeout (minutes)', hint: 'A session is killed after this long.', kind: 'minutes' },
  { key: 'runtime.maxTurnsPerSession', label: 'Max turns per session', hint: 'Upper bound on agent tool-use turns per run.', kind: 'int' },
  { key: 'runtime.defaultModel', label: 'Default model for new agents', hint: 'Existing agents keep their own model (Organization → agent).', kind: 'model' },
  { key: 'recruitment.requiresOwnerApproval', label: 'Recruitment requires owner approval', hint: 'When on, the CEO cannot hire without you.', kind: 'bool' },
  { key: 'recruitment.maxAgents', label: 'Max agents', hint: 'Hard cap on organization size.', kind: 'int' },
];

export default function Settings() {
  const pol = useResource<any[]>('/api/policies', ['paused']);
  const audit = useResource<any[]>('/api/audit', ['session.status', 'task', 'org']);
  const [err, setErr] = useState(''); const [saved, setSaved] = useState('');
  if (!pol.data) return <Empty>Loading…</Empty>;
  const val = (k: string) => pol.data!.find((p) => p.key === k)?.value;

  async function save(key: string, value: unknown) {
    setErr(''); setSaved('');
    try { await api('PUT', `/api/policies/${key}`, { value }); setSaved(key); pol.reload(); } catch (e) { setErr((e as Error).message); }
  }

  return (
    <div className="grid gap-4 p-5 xl:grid-cols-[minmax(0,560px)_1fr]">
      <Section title="Organization policies">
        <div className="divide-y divide-line">
          {FIELDS.map((f) => {
            const v = val(f.key);
            return (
              <div key={f.key} className="flex items-center gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px]">{f.label}</div>
                  <div className="text-[11px] text-faint">{f.hint}</div>
                </div>
                {f.kind === 'bool' ? (
                  <button className={`btn ${v ? 'btn-primary' : ''}`} onClick={() => save(f.key, !v)}>{v ? 'On' : 'Off'}</button>
                ) : f.kind === 'model' ? (
                  <select className="field w-28" value={v ?? 'opus'} onChange={(e) => save(f.key, e.target.value)}>{MODELS.map((m) => <option key={m}>{m}</option>)}</select>
                ) : (
                  <input key={String(v)} className="field w-24 text-right font-mono" type="number" min={1}
                    defaultValue={f.kind === 'minutes' ? Math.round(v / 60000) : v}
                    onBlur={(e) => { const n = Number(e.target.value); if (n > 0 && n !== (f.kind === 'minutes' ? Math.round(v / 60000) : v)) save(f.key, f.kind === 'minutes' ? n * 60000 : n); }} />
                )}
                {saved === f.key && <span className="text-[11px] text-matcha">saved</span>}
              </div>
            );
          })}
        </div>
        {err && <div className="px-4 pb-3 text-[12px] text-shu">{err}</div>}
      </Section>

      <Section title="Audit log" className="max-h-[calc(100vh-130px)]">
        <div className="h-full overflow-y-auto">
          {(audit.data ?? []).map((a) => (
            <div key={a.id} className="grid grid-cols-[70px_70px_150px_1fr] gap-3 border-b border-line/60 px-4 py-1.5 font-mono text-[11px]">
              <span className="text-faint">{ago(a.created_at)}</span><span className="truncate text-dim">{a.actor}</span>
              <span className="truncate">{a.action}</span><span className="truncate text-faint" title={a.details}>{a.target} {a.details !== '{}' ? a.details : ''}</span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
