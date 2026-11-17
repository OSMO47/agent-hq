import { useState, type ReactNode } from 'react';
import { api, useResource, ago, MODELS } from '../api';
import { Empty } from '../ui';

const DIFF = [
  { key: 'easy', th: 'ง่าย', hint: 'Docs, small edits, simple lookups' },
  { key: 'medium', th: 'กลาง', hint: 'Features, bug fixes, tests' },
  { key: 'hard', th: 'ยาก', hint: 'Architecture, planning, tricky debugging' },
] as const;

const MODEL_NOTE: Record<string, string> = { haiku: 'fastest · lightest quota', sonnet: 'balanced', opus: 'strongest · heaviest quota' };

function Segmented({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <div className="inline-flex rounded-md border border-line-strong bg-ink p-0.5">
      {options.map((o) => (
        <button key={o} onClick={() => o !== value && onChange(o)}
          className={`h-6 min-w-16 rounded-[5px] px-2.5 text-[12px] transition-colors ${o === value ? 'bg-fg font-medium text-ink' : 'text-dim hover:text-fg'}`}>{o}</button>
      ))}
    </div>
  );
}

function Stepper({ value, min = 1, max = 999, step = 1, unit, onChange }: { value: number; min?: number; max?: number; step?: number; unit?: string; onChange: (v: number) => void }) {
  const set = (v: number) => onChange(Math.min(max, Math.max(min, v)));
  return (
    <div className="inline-flex items-center rounded-md border border-line-strong bg-ink">
      <button className="h-7 w-7 text-dim hover:text-fg disabled:opacity-30" disabled={value <= min} onClick={() => set(value - step)} aria-label="Decrease">−</button>
      <span className="min-w-14 text-center font-mono text-[12.5px]">{value}{unit && <span className="ml-1 text-faint">{unit}</span>}</span>
      <button className="h-7 w-7 text-dim hover:text-fg disabled:opacity-30" disabled={value >= max} onClick={() => set(value + step)} aria-label="Increase">+</button>
    </div>
  );
}

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={on} onClick={() => onChange(!on)}
      className={`relative h-5 w-9 rounded-full transition-colors ${on ? 'bg-matcha' : 'bg-line-strong'}`}>
      <span className={`absolute top-0.5 size-4 rounded-full bg-fg transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  );
}

function Group({ title, desc, children }: { title: string; desc: string; children: ReactNode }) {
  return (
    <section className="rise grid gap-4 border-b border-line py-7 last:border-0 lg:grid-cols-[240px_1fr]">
      <div><h2 className="text-[13.5px] font-medium">{title}</h2><p className="mt-1 text-[12px] leading-relaxed text-faint">{desc}</p></div>
      <div className="card divide-y divide-line">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center gap-4 px-4 py-3">
      <div className="min-w-0 flex-1"><div className="text-[12.5px]">{label}</div>{hint && <div className="mt-0.5 text-[11.5px] text-faint">{hint}</div>}</div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export default function Settings() {
  const pol = useResource<any[]>('/api/policies', ['paused']);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tab, setTab] = useState<'policies' | 'audit'>('policies');
  if (!pol.data) return <Empty>Loading…</Empty>;
  const val = (k: string, d?: any) => pol.data!.find((p) => p.key === k)?.value ?? d;

  async function save(key: string, value: unknown, label: string) {
    try { await api('PUT', `/api/policies/${key}`, { value }); setMsg({ ok: true, text: `Saved · ${label}` }); pol.reload(); }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    setTimeout(() => setMsg(null), 2500);
  }
  const byDiff = val('models.byDifficulty', { easy: 'haiku', medium: 'sonnet', hard: 'opus' });

  return (
    <div className="mx-auto max-w-[960px] px-6 pb-10">
      <div className="sticky top-0 z-10 flex h-12 items-center gap-1 border-b border-line bg-ink/90 backdrop-blur">
        {(['policies', 'audit'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`h-12 border-b-2 px-3 text-[12.5px] ${tab === t ? 'border-shu text-fg' : 'border-transparent text-dim hover:text-fg'}`}>
            {t === 'policies' ? 'Policies' : 'Audit log'}
          </button>
        ))}
        {msg && <span className={`rise ml-auto text-[12px] ${msg.ok ? 'text-matcha' : 'text-shu'}`}>{msg.text}</span>}
      </div>

      {tab === 'policies' ? (
        <>
          <Group title="Model by task difficulty" desc="Each task's difficulty decides which Claude model runs it. Tasks without a difficulty use the agent's own model.">
            {DIFF.map((d) => (
              <Row key={d.key} label={<><span className="capitalize">{d.key}</span><span className="ml-2 text-faint">{d.th}</span></>}
                hint={`${d.hint} · ${MODEL_NOTE[byDiff[d.key]] ?? ''}`}>
                <Segmented value={byDiff[d.key]} options={MODELS} onChange={(m) => save('models.byDifficulty', { ...byDiff, [d.key]: m }, `${d.key} → ${m}`)} />
              </Row>
            ))}
            <Row label="Leader assessment" hint="Model a department leader uses to rate a task with no difficulty. Runs with no tools (~4k tokens).">
              <Segmented value={val('models.assessment', 'sonnet')} options={MODELS} onChange={(m) => save('models.assessment', m, `assessment → ${m}`)} />
            </Row>
            <Row label="Escalate when harder than expected" hint="Agent says ESCALATE or runs out of turns → next level up, same conversation continues.">
              <Switch on={!!val('models.autoEscalate', true)} onChange={(v) => save('models.autoEscalate', v, `auto-escalate ${v ? 'on' : 'off'}`)} />
            </Row>
            <Row label="Default model for new agents" hint="Design agents (Product & Design leader, UI/UX Designer, UX Researcher) are fixed on opus — change per agent in Organization.">
              <Segmented value={val('runtime.defaultModel', 'opus')} options={MODELS} onChange={(m) => save('runtime.defaultModel', m, `default → ${m}`)} />
            </Row>
          </Group>

          <Group title="Runtime limits" desc="Guards for this machine and your Claude plan. On a usage limit the queue waits for the reset and resumes — it never switches model on its own.">
            <Row label="Concurrent sessions" hint="Claude processes at once. Each uses a few hundred MB of RAM.">
              <Stepper value={val('runtime.maxConcurrentSessions', 2)} max={8} onChange={(v) => save('runtime.maxConcurrentSessions', v, `concurrency ${v}`)} />
            </Row>
            <Row label="Session timeout" hint="A run is stopped after this long.">
              <Stepper value={Math.round(val('runtime.sessionTimeoutMs', 1_200_000) / 60000)} min={5} max={240} step={5} unit="min"
                onChange={(v) => save('runtime.sessionTimeoutMs', v * 60000, `timeout ${v} min`)} />
            </Row>
            <Row label="Max turns per session" hint="Upper bound on tool-use steps in one run.">
              <Stepper value={val('runtime.maxTurnsPerSession', 30)} min={1} max={200} step={5} onChange={(v) => save('runtime.maxTurnsPerSession', v, `max turns ${v}`)} />
            </Row>
          </Group>

          <Group title="Recruitment" desc="How the organization may grow. Agents can request; only policy and you decide.">
            <Row label="Owner approval required" hint="When on, the CEO cannot hire without you.">
              <Switch on={!!val('recruitment.requiresOwnerApproval', true)} onChange={(v) => save('recruitment.requiresOwnerApproval', v, `owner approval ${v ? 'on' : 'off'}`)} />
            </Row>
            <Row label="Maximum agents" hint="Hard cap on organization size.">
              <Stepper value={val('recruitment.maxAgents', 40)} min={1} max={200} onChange={(v) => save('recruitment.maxAgents', v, `max agents ${v}`)} />
            </Row>
          </Group>
        </>
      ) : <Audit />}
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = {
  'policy.set': 'Changed policy', 'task.transition': 'Moved task', 'task.update': 'Edited task', 'project.create': 'Created project',
  'session.enqueue': 'Queued session', 'session.stopped': 'Stopped session', 'session.timeout': 'Session timed out', 'session.stopAll': 'Stopped all sessions',
  'session.recover': 'Recovered sessions', 'task.recover': 'Recovered tasks', 'agent.update': 'Edited agent', 'org.seed': 'Created organization',
  'runtime.rateLimited': 'Hit usage limit', 'task.assess': 'Rated task difficulty', 'task.escalate': 'Escalated task model',
};

function Audit() {
  const audit = useResource<any[]>('/api/audit', ['session.status', 'task', 'org', 'paused']);
  const [open, setOpen] = useState<number | null>(null);
  if (!audit.data) return <Empty>Loading…</Empty>;
  return (
    <div className="card rise mt-6 overflow-hidden">
      <div className="grid grid-cols-[90px_90px_1fr_auto] gap-4 border-b border-line px-4 py-2 label"><span>When</span><span>Who</span><span>What</span><span /></div>
      {audit.data.map((a) => {
        const details = a.details && a.details !== '{}' ? a.details : null;
        return (
          <div key={a.id} className="border-b border-line/60 last:border-0">
            <button disabled={!details} onClick={() => setOpen(open === a.id ? null : a.id)}
              className="grid w-full grid-cols-[90px_90px_1fr_auto] items-center gap-4 px-4 py-2 text-left text-[12px] hover:bg-raise/50 disabled:cursor-default disabled:hover:bg-transparent">
              <span className="font-mono text-[11px] text-faint">{ago(a.created_at)}</span>
              <span className={`truncate ${a.actor === 'owner' ? 'text-shu' : 'text-dim'}`}>{a.actor}</span>
              <span className="min-w-0 truncate">{ACTION_LABEL[a.action] ?? a.action}{a.target && <span className="ml-2 font-mono text-[11px] text-faint">{a.target}</span>}</span>
              <span className="text-faint">{details ? (open === a.id ? '−' : '+') : ''}</span>
            </button>
            {open === a.id && details && <pre className="mx-4 mb-3 overflow-x-auto rounded-md bg-ink p-3 font-mono text-[11px] text-dim">{JSON.stringify(JSON.parse(details), null, 2)}</pre>}
          </div>
        );
      })}
    </div>
  );
}
