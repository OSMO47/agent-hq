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
  return <div className="space-y-3 p-3">{data.map((it) => it.kind === 'finished' ? <Finished key={`f:${it.project.id}`} it={it} onDone={reload} /> : <Item key={`${it.kind}:${it.task.id}`} it={it} agents={agents} onDone={reload} />)}</div>;
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

/** "Work is done: deploy?" Only the owner can trigger this; it runs the project's own deploy command. */
function Finished({ it, onDone }: { it: any; onDone: () => void }) {
  const p = it.project; const st = it.deploy;
  const [cmd, setCmd] = useState(it.command ?? '');
  const [commit, setCommit] = useState(!!it.git?.files);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(''); try { await fn(); onDone(); } catch (e) { setErr((e as Error).message); } setBusy(false); };

  return (
    <div className="rise rounded-lg border border-matcha/50 bg-matcha/[.05] p-3">
      <div className="flex items-center gap-2 text-[10.5px]">
        <span className="font-bold uppercase tracking-wider text-matcha">✓ งานเสร็จแล้ว</span>
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
          <div className="text-[12px]">Deploy ขึ้นเว็บเลยไหม?</div>
          <input className="field font-mono text-[11.5px]" value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="คำสั่ง deploy เช่น deploy.bat หรือ firebase deploy" />
          {it.git?.files > 0 && (
            <label className="flex items-center gap-2 text-[11.5px]"><input type="checkbox" checked={commit} onChange={(e) => setCommit(e.target.checked)} />
              commit ไฟล์ที่แก้ ({it.git.files} ไฟล์) ก่อน deploy</label>
          )}
          <div className="flex gap-2">
            <button className="btn btn-primary flex-1" disabled={busy || !cmd.trim()} onClick={() => act(() => api('POST', `/api/projects/${p.id}/deploy`, { command: cmd, commit }))}>🚀 Deploy</button>
            <button className="btn flex-1" disabled={busy} onClick={() => act(() => api('POST', `/api/projects/${p.id}/deploy/skip`))}>ยังไม่ deploy</button>
          </div>
          <div className="text-[10.5px] text-faint">agent deploy เองไม่ได้ จะ deploy ก็ต่อเมื่อคุณกดปุ่มนี้</div>
        </div>
      )}

      {st && (
        <div className="mt-3 space-y-2">
          <div className={`text-[12px] ${st.running ? 'breathe text-kin' : st.ok ? 'text-matcha' : 'text-shu'}`}>
            {st.running ? '● กำลัง deploy…' : st.ok ? '✓ Deploy สำเร็จ' : '✕ Deploy ไม่สำเร็จ'}
          </div>
          <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md bg-black/40 p-2.5 text-[10.5px] leading-relaxed text-dim">{st.output.slice(-6000)}</pre>
          {!st.running && (
            <div className="flex gap-2">
              {!st.ok && <button className="btn flex-1" disabled={busy} onClick={() => act(() => api('POST', `/api/projects/${p.id}/deploy`, { command: st.command, commit: false }))}>↻ ลองใหม่</button>}
              <button className="btn flex-1" disabled={busy} onClick={() => act(() => api('POST', `/api/projects/${p.id}/deploy/dismiss`))}>ปิด</button>
            </div>
          )}
        </div>
      )}
      {err && <div className="mt-2 text-[11.5px] text-shu">{err}</div>}
    </div>
  );
}
