import { useState } from 'react';
import { api, useResource, ago } from './api';
import { Empty } from './ui';
import { Markdown } from './Markdown';

/**
 * Owner inbox: the only things that need a human while autopilot runs the organization.
 *  decision   → an agent flagged NEEDS_OWNER (or hit a blocked tool): Approve, or reply and send back
 *  failed     → Retry or Cancel
 *  unassigned → the CEO could not pick anyone: choose
 */
export function InboxTab({ agents }: { agents: any[] }) {
  const { data, reload } = useResource<any[]>('/api/inbox', ['task', 'session.status', 'paused', 'deploy', 'project']);
  if (!data) return <Empty>Loading…</Empty>;
  if (data.length === 0) return (
    <Empty><div className="space-y-1"><div className="text-[18px] text-matcha">✓</div><div>ไม่มีเรื่องรอคุณ</div><div>ทีมแบ่งงาน ทำงาน และอนุมัติงานปกติกันเองอยู่</div></div></Empty>
  );
  return <div className="space-y-3 p-3">{data.map((it) => it.kind === 'meeting' ? <MeetingItem key={`m:${it.meeting.id}`} it={it} /> : it.kind === 'finished' ? <Finished key={`f:${it.project.id}`} it={it} onDone={reload} /> : <Item key={`${it.kind}:${it.task.id}`} it={it} agents={agents} onDone={reload} />)}</div>;
}

const KIND = { decision: ['รอคุณตัดสินใจ', 'text-accent border-accent/40'], failed: ['งานล้มเหลว', 'text-shu border-shu/40'], unassigned: ['ยังไม่มีคนรับงาน', 'text-kin border-kin/40'] } as const;

function Item({ it, agents, onDone }: { it: any; agents: any[]; onDone: () => void }) {
  const [reply, setReply] = useState(''); const [open, setOpen] = useState(false); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const t = it.task;
  const who = agents.find((a) => a.id === t.assignee_id);
  const [label, tone] = KIND[it.kind as keyof typeof KIND];
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(''); try { await fn(); onDone(); } catch (e) { setErr((e as Error).message); } setBusy(false); };
  const move = (to: string, note?: string) => act(() => api('POST', `/api/tasks/${t.id}/transition`, { to, note }));

  return (
    <div className={`rise rounded-lg border bg-ink/40 p-3 ${tone.split(' ')[1]}`}>
      <div className="flex items-center gap-2 text-[10.5px]">
        <span className={`font-bold uppercase tracking-wider ${tone.split(' ')[0]}`}>{label}</span>
        <span className="ml-auto text-faint">{ago(t.updated_at)}</span>
      </div>
      <a href={`#/tasks/${t.id}`} className="mt-1 block text-[12.5px] leading-snug hover:underline">{t.title}</a>
      {who && <div className="mt-0.5 text-[10.5px] text-faint">∿ {who.name}{who.name !== who.role ? ` · ${who.role}` : ''}</div>}

      {it.question && <div className="mt-2 whitespace-pre-wrap rounded-md border border-accent/30 bg-accent/[.06] px-2.5 py-2 text-[12px]">{it.question}</div>}
      {it.report && (
        <div className="mt-2">
          <button className="text-[11px] text-ai hover:underline" onClick={() => setOpen(!open)}>{open ? '⌃ ซ่อนรายงาน' : '⌄ ดูรายงานของ agent'}</button>
          {open && <div className="mt-1 max-h-72 overflow-y-auto rounded-md border border-line p-2.5"><Markdown text={it.report} /></div>}
        </div>
      )}

      {it.kind === 'decision' && (
        <div className="mt-3 space-y-2">
          <textarea className="field text-[12px]" rows={2} placeholder="คำตอบหรือสิ่งที่อยากให้แก้ (ไม่บังคับ) จะส่งกลับไปให้ agent ทำต่อ" value={reply} onChange={(e) => setReply(e.target.value)} />
          <div className="flex gap-2">
            <button className="btn btn-primary flex-1" disabled={busy} onClick={() => move('DONE')}>✓ อนุมัติ</button>
            <button className="btn flex-1" disabled={busy || !reply.trim()} onClick={() => move('ASSIGNED', reply.trim())} title="ส่งคำตอบกลับไป agent จะทำต่อเองอัตโนมัติ">↩ ส่งกลับไปแก้</button>
          </div>
        </div>
      )}
      {it.kind === 'failed' && (
        <div className="mt-3 flex gap-2">
          <button className="btn flex-1" disabled={busy} onClick={() => move('ASSIGNED', 'ลองใหม่หลังจากล้มเหลว')}>↻ ลองใหม่</button>
          <button className="btn btn-danger flex-1" disabled={busy} onClick={() => move('CANCELLED')}>ยกเลิกงาน</button>
        </div>
      )}
      {it.kind === 'unassigned' && (
        <select className="field mt-3" defaultValue="" disabled={busy}
          onChange={(e) => e.target.value && act(() => api('PATCH', `/api/tasks/${t.id}`, { assigneeId: e.target.value }))}>
          <option value="">เลือกคนรับงานนี้…</option>
          {agents.filter((a) => a.level > 1 && a.status === 'active').map((a) => <option key={a.id} value={a.id}>{a.name === a.role ? a.role : `${a.name} · ${a.role}`}</option>)}
        </select>
      )}
      {err && <div className="mt-2 text-[11.5px] text-shu">{err}</div>}
    </div>
  );
}

/**
 * "Work is done": the owner chooses what to publish. Steps run in order and stop at the first failure:
 *   commit (files the agents changed) → push (to the branch upstream / origin, read from the project's git config) → deploy.
 * Agents can never do any of this themselves.
 */
export function Finished({ it, onDone }: { it: any; onDone: () => void }) {
  const p = it.project; const st = it.deploy; const g = it.git;
  const [cmd, setCmd] = useState(it.command ?? '');
  const [commit, setCommit] = useState(!!g?.files);
  const [push, setPush] = useState(!!g?.remote);
  const [deploy, setDeploy] = useState(!!it.command);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(''); try { await fn(); onDone(); } catch (e) { setErr((e as Error).message); } setBusy(false); };
  const host = (u: string | null) => (u ?? '').replace(/^https?:\/\//, '').replace(/^git@([^:]+):/, '$1/').replace(/\.git$/, '');
  const pending = (g?.ahead ?? 0) + (commit && g?.files ? 1 : 0);
  const any = commit || push || deploy;
  const label = [commit && 'commit', push && 'push', deploy && 'deploy'].filter(Boolean).join(' → ');
  const Opt = ({ on, set, disabled, children }: { on: boolean; set: (v: boolean) => void; disabled?: boolean; children: React.ReactNode }) => (
    <label className={`flex items-start gap-2 rounded-md border px-2.5 py-2 text-[11.5px] ${disabled ? 'border-line opacity-50' : on ? 'border-matcha/40' : 'border-line'}`}>
      <input type="checkbox" className="mt-0.5" checked={on && !disabled} disabled={disabled} onChange={(e) => set(e.target.checked)} />
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  );

  return (
    <div className="rise rounded-lg border border-matcha/50 bg-matcha/[.05] p-3">
      <div className="flex items-center gap-2 text-[10.5px]">
        <span className="font-bold uppercase tracking-wider text-matcha">{it.done.length ? '✓ งานเสร็จแล้ว' : '⇡ เผยแพร่โปรเจกต์'}</span>
        <span className="ml-auto text-faint">{ago(it.task.updated_at)}</span>
      </div>
      <div className="mt-1 text-[13px]">{p.name}</div>
      {it.done.length > 0 && (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[11.5px] text-dim marker:text-matcha">
          {it.done.map((d: any) => <li key={d.id}><a className="hover:underline" href={`#/tasks/${d.id}`}>{d.title}</a></li>)}
        </ul>
      )}

      {!st && (
        <div className="mt-3 space-y-2">
          <div className="text-[12px]">จะเผยแพร่งานนี้ไหม?</div>
          <Opt on={commit} set={setCommit} disabled={!g || !g.files}>
            <b>Commit</b> {g ? (g.files ? `ไฟล์ที่แก้ ${g.files} ไฟล์` : 'ไม่มีไฟล์ค้าง') : '(ไม่ใช่ git repo)'}
          </Opt>
          <Opt on={push} set={setPush} disabled={!g?.remote}>
            <b>Push</b> {g?.remote ? <>
              → <span className="text-ai">{g.remote}</span> · <span className="font-mono">{host(g.url)}</span> · branch <span className="text-accent">{g.branch}</span>
              <div className="text-faint">{g.upstream ? `ตาม upstream ${g.upstream}` : `ยังไม่มี upstream: จะ push -u ${g.remote} ${g.branch}`}{pending > 0 && ` · ${pending} commit จะถูกส่งขึ้นไป`}</div>
            </> : <span className="text-faint">ไม่มี git remote (เพิ่มด้วย git remote add origin &lt;url&gt;)</span>}
          </Opt>
          <Opt on={deploy} set={setDeploy}>
            <b>Deploy</b> ขึ้นเว็บ
            <input className="field mt-1.5 h-7 font-mono text-[11px]" value={cmd} onChange={(e) => setCmd(e.target.value)} onClick={(e) => e.preventDefault()}
              placeholder="คำสั่ง deploy เช่น deploy.bat หรือ npm run deploy" />
          </Opt>
          <div className="flex gap-2">
            <button className="btn btn-primary flex-1" disabled={busy || !any || (deploy && !cmd.trim())}
              onClick={() => act(() => api('POST', `/api/projects/${p.id}/deploy`, { command: cmd, commit: commit && !!g?.files, push: push && !!g?.remote, deploy }))}>
              ▶ {label || 'เลือกอย่างน้อย 1 อย่าง'}
            </button>
            <button className="btn" disabled={busy} onClick={() => act(() => api('POST', `/api/projects/${p.id}/deploy/skip`))}>ยังไม่ทำ</button>
          </div>
          <div className="text-[10.5px] text-faint">agent push / deploy เองไม่ได้ จะเกิดขึ้นเฉพาะตอนที่คุณกดปุ่มนี้</div>
        </div>
      )}

      {st && (
        <div className="mt-3 space-y-2">
          <div className={`text-[12px] ${st.running ? 'breathe text-kin' : st.ok ? 'text-matcha' : 'text-shu'}`}>
            {st.running ? `● กำลังทำ: ${st.steps.join(' → ')}…` : st.ok ? `✓ สำเร็จ: ${st.steps.join(' → ')}` : '✕ ไม่สำเร็จ (หยุดที่ขั้นที่ผิดพลาด)'}
          </div>
          <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md bg-black/40 p-2.5 text-[10.5px] leading-relaxed text-dim">{st.output.slice(-6000)}</pre>
          {!st.running && (
            <div className="flex gap-2">
              {!st.ok && <button className="btn flex-1" disabled={busy} onClick={() => act(() => api('POST', `/api/projects/${p.id}/deploy/dismiss`))}>↻ ลองใหม่</button>}
              <button className="btn flex-1" disabled={busy} onClick={() => act(() => api('POST', `/api/projects/${p.id}/deploy/dismiss`))}>ปิด</button>
            </div>
          )}
        </div>
      )}
      {err && <div className="mt-2 text-[11.5px] text-shu">{err}</div>}
    </div>
  );
}

/** A finished idea meeting with ideas waiting for the owner. */
function MeetingItem({ it }: { it: any }) {
  return (
    <a href={`#/meetings/${it.meeting.id}`} className="rise block rounded-lg border border-ai/50 bg-ai/[.05] p-3 hover:border-ai">
      <div className="flex items-center gap-2 text-[10.5px]">
        <span className="font-bold uppercase tracking-wider text-ai">◎ ประชุมเสร็จแล้ว</span>
        <span className="ml-auto text-faint">{ago(it.task.updated_at)}</span>
      </div>
      <div className="mt-1 line-clamp-2 text-[12.5px] leading-snug">{it.meeting.topic}</div>
      <div className="mt-2 text-[11.5px] text-accent">{it.meeting.plan ? 'CEO เลือกผู้เข้าประชุมแล้ว → ตรวจรายชื่อและอนุมัติ' : `${it.meeting.pending} ไอเดียรออนุมัติ → เปิดห้องประชุม`}</div>
    </a>
  );
}
