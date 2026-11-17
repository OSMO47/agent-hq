import { useEffect, useRef, useState } from 'react';
import { api, useResource, useLive, ago } from '../api';
import { Empty } from '../ui';
import { Markdown } from '../Markdown';

const STATUS: Record<string, [string, string]> = {
  running: ['กำลังประชุม', 'text-kin'], summarizing: ['CEO กำลังสรุป', 'text-kin'], done: ['เสร็จแล้ว', 'text-matcha'],
  stopped: ['หยุดแล้ว', 'text-faint'], failed: ['ล้มเหลว', 'text-shu'],
};
const DEFAULT_PEOPLE = ['prod-dir', 'eng-dir', 'ui-ux-designer', 'qa-dir'];

/** Idea meeting room: list of meetings on the left, the selected meeting (or a new one) on the right. */
export default function Meetings({ param }: { param?: string }) {
  const list = useResource<any[]>('/api/meetings', ['meeting']);
  const sel = param ?? list.data?.[0]?.id ?? 'new';
  return (
    <div className="grid h-full grid-cols-[300px_1fr]">
      <div className="flex min-h-0 flex-col border-r border-line">
        <div className="p-3"><a className="btn btn-primary w-full" href="#/meetings/new">＋ ประชุมใหม่</a></div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {list.data?.length === 0 && <Empty>ยังไม่มีการประชุม</Empty>}
          {list.data?.map((m) => {
            const [label, tone] = STATUS[m.status] ?? [m.status, 'text-dim'];
            return (
              <a key={m.id} href={`#/meetings/${m.id}`}
                className={`block border-b border-l-2 border-line/60 px-4 py-2.5 transition-colors ${m.id === sel ? 'border-l-accent bg-raise' : 'border-l-transparent hover:bg-raise/50'}`}>
                <div className="line-clamp-2 text-[12.5px] leading-snug">{m.topic}</div>
                <div className="mt-1 flex items-center gap-2 text-[10.5px]">
                  <span className={tone}>{['running', 'summarizing'].includes(m.status) ? '● ' : ''}{label}</span>
                  {m.pending > 0 && <span className="pill text-accent">{m.pending} ไอเดียรออนุมัติ</span>}
                  <span className="ml-auto text-faint">{ago(m.created_at)}</span>
                </div>
                <div className="mt-0.5 truncate text-[10.5px] text-faint">{m.project_name}</div>
              </a>
            );
          })}
        </div>
      </div>
      {sel === 'new' ? <NewMeeting /> : <Room key={sel} id={sel} />}
    </div>
  );
}

function NewMeeting() {
  const projects = useResource<any[]>('/api/projects', ['project']);
  const org = useResource<{ departments: any[]; agents: any[] }>('/api/org', ['org']);
  const [topic, setTopic] = useState(''); const [pid, setPid] = useState('');
  const [people, setPeople] = useState<string[]>(DEFAULT_PEOPLE);
  const [rounds, setRounds] = useState(2);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (!pid && projects.data?.[0]) setPid(projects.data[0].id); }, [projects.data, pid]);
  if (!org.data || !projects.data) return <Empty>Loading…</Empty>;
  if (projects.data.length === 0) return <Empty>สร้างโปรเจกต์ใน Task board ก่อน ไอเดียที่อนุมัติจะกลายเป็นงานในโปรเจกต์นั้น</Empty>;
  const toggle = (id: string) => setPeople((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 6 ? p : [...p, id]));
  const groups = org.data.departments.map((d) => ({ d, agents: org.data!.agents.filter((a) => a.department_id === d.id && a.status === 'active').sort((a, b) => a.level - b.level) }));

  return (
    <div className="min-h-0 overflow-y-auto">
      <form className="mx-auto max-w-[760px] space-y-5 p-6" onSubmit={async (e) => {
        e.preventDefault(); setErr(''); setBusy(true);
        try { const m = await api('POST', '/api/meetings', { projectId: pid, topic, participants: people, rounds }); location.hash = `#/meetings/${m.id}`; }
        catch (x) { setErr((x as Error).message); setBusy(false); }
      }}>
        <div>
          <div className="text-[15px] font-semibold">ห้องประชุมเสนอไอเดีย</div>
          <div className="mt-1 text-[12px] leading-relaxed text-dim">
            ตั้งหัวข้อ แล้วทีมจะผลัดกันเสนอไอเดียทีละคน แต่ละคนเห็นสิ่งที่คนก่อนพูดและเปิดดูโค้ดได้ (อ่านอย่างเดียว ไม่แก้ไฟล์)
            จบแล้ว CEO สรุปไอเดียที่ดีที่สุดเป็นการ์ด คุณกด <span className="text-matcha">อนุมัติ</span> ข้อไหน ข้อนั้นจะกลายเป็นงานให้ทีมทำต่อเอง
          </div>
        </div>
        <label className="block space-y-1"><span className="label">หัวข้อ / โจทย์</span>
          <textarea className="field" rows={4} required autoFocus value={topic} onChange={(e) => setTopic(e.target.value)}
            placeholder="เช่น ทำยังไงให้ผู้เรียน N5 กลับมาเรียนทุกวัน โดยไม่ต้องเพิ่มเนื้อหาใหม่" /></label>
        <label className="block space-y-1"><span className="label">โปรเจกต์ (ทีมจะดูโค้ดของโปรเจกต์นี้ และไอเดียที่อนุมัติจะเป็นงานในนี้)</span>
          <select className="field" value={pid} onChange={(e) => setPid(e.target.value)}>{projects.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>

        <div className="space-y-2">
          <div className="flex items-baseline justify-between"><span className="label">ผู้เข้าประชุม (2-6 คน) · CEO เป็นประธานสรุปเสมอ</span><span className="text-[11px] text-faint">เลือกแล้ว {people.length}</span></div>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
            {groups.map(({ d, agents }) => (
              <div key={d.id} className="rounded-lg border border-line p-2">
                <div className="mb-1 px-1 text-[10.5px] uppercase tracking-wider text-faint">{d.name}</div>
                {agents.map((a) => {
                  const on = people.includes(a.id);
                  return (
                    <button type="button" key={a.id} onClick={() => toggle(a.id)}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11.5px] transition-colors ${on ? 'bg-accent/15 text-fg' : 'text-dim hover:bg-raise'}`}>
                      <span className={`grid size-3.5 shrink-0 place-items-center rounded border text-[9px] ${on ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong'}`}>{on ? '✓' : ''}</span>
                      <span className="truncate">{a.name === a.role ? a.role : `${a.name} · ${a.role}`}</span>
                      {a.model_mode === 'fixed' && <span className="chip ml-auto text-kin">{a.model}</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className="label">จำนวนรอบ</span>
          {[1, 2, 3].map((r) => (
            <button type="button" key={r} onClick={() => setRounds(r)}
              className={`rounded-md border px-3 py-1 text-[12px] ${rounds === r ? 'border-accent text-accent' : 'border-line text-dim hover:border-line-strong'}`}>{r}</button>
          ))}
          <span className="text-[11px] text-faint">รอบแรกเสนอไอเดีย รอบถัดไปต่อยอด/แย้งกัน · ใช้ทั้งหมด ~{people.length * rounds + 1} session (อ่านอย่างเดียว)</span>
        </div>
        {err && <div className="text-[12px] text-shu">{err}</div>}
        <button className="btn btn-primary h-9 px-5" disabled={busy || people.length < 2 || !topic.trim()}>◎ เริ่มประชุม</button>
      </form>
    </div>
  );
}

function Room({ id }: { id: string }) {
  const { data, reload } = useResource<any>(`/api/meetings/${id}`, ['meeting']);
  const org = useResource<{ agents: any[] }>('/api/org', ['org']);
  const [live, setLive] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const curId = data?.current?.id;
  useEffect(() => setLive(''), [curId]);
  useLive((m) => {
    if (m.type === 'session.event' && m.sessionId === curId && m.event.kind === 'text') setLive((t) => t + m.event.text);
    if (m.type === 'session.status' && m.sessionId === curId) reload();
  });
  useEffect(() => { const el = box.current; if (el) el.scrollTop = el.scrollHeight; }, [data?.messages?.length, live, data?.meeting?.status]);
  if (!data) return <Empty>Loading…</Empty>;
  const m = data.meeting;
  const people: string[] = JSON.parse(m.participants);
  const who = (aid: string) => org.data?.agents.find((a) => a.id === aid);
  const [label, tone] = STATUS[m.status] ?? [m.status, 'text-dim'];
  const active = ['running', 'summarizing'].includes(m.status);
  let lastRound = 0;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="shrink-0 border-b border-line px-5 py-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold leading-snug">{m.topic}</div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
              <span className={tone}>{active ? '● ' : ''}{label}</span>
              <span className="text-faint">· {m.project_name} · {m.rounds} รอบ ·</span>
              {people.map((p) => <span key={p} className="chip text-ai">{who(p)?.name ?? p}</span>)}
              <span className="chip text-kin">CEO ประธาน</span>
            </div>
          </div>
          {active && <button className="btn btn-danger" onClick={() => api('POST', `/api/meetings/${id}/stop`).then(reload)}>■ หยุดประชุม</button>}
        </div>
      </div>

      <div ref={box} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
        {data.messages.map((x: any) => {
          const sep = x.round !== lastRound; lastRound = x.round;
          return (
            <div key={x.id}>
              {sep && <div className="mb-3 flex items-center gap-3 text-[10.5px] uppercase tracking-wider text-faint"><span className="h-px flex-1 bg-line" />รอบ {x.round}<span className="h-px flex-1 bg-line" /></div>}
              <Bubble name={x.name} role={x.role} at={x.created_at} href={x.session_id ? `#/sessions/${x.session_id}` : undefined}><Markdown text={x.body} /></Bubble>
            </div>
          );
        })}

        {active && data.current && (
          <Bubble name={data.current.name} role={m.status === 'summarizing' ? 'ประธาน กำลังสรุป' : data.current.role} live href={`#/sessions/${data.current.id}`}>
            {live ? <Markdown text={live} /> : <div className="breathe text-[12px] text-kin">● {data.current.status === 'queued' ? 'รอคิว…' : 'กำลังคิด / อ่านโค้ด…'}</div>}
          </Bubble>
        )}

        {m.summary && (
          <div className="rounded-xl border border-accent/40 bg-accent/[.06] p-4">
            <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-accent">สรุปจาก CEO</div>
            <Markdown text={m.summary} />
          </div>
        )}
        {data.ideas.length > 0 && (
          <div className="space-y-2">
            <div className="label">ไอเดียที่เสนอ · กดอนุมัติ = สร้างเป็นงานให้ทีมทำ</div>
            {data.ideas.map((i: any) => <IdeaCard key={i.id} i={i} who={who} onDone={reload} />)}
          </div>
        )}
        {m.status === 'failed' && <div className="text-[12px] text-shu">การประชุมหยุดเพราะมีคนตอบไม่สำเร็จ ดูรายละเอียดได้ที่ Live sessions</div>}
      </div>
    </div>
  );
}

function Bubble({ name, role, at, live, href, children }: { name: string; role: string; at?: string; live?: boolean; href?: string; children: React.ReactNode }) {
  return (
    <div className={`rounded-xl border px-4 py-3 ${live ? 'border-kin/40' : 'border-line bg-panel'}`}>
      <div className="mb-1.5 flex items-center gap-2 text-[11px]">
        <span className="text-ai">{name}</span><span className="text-faint">{role}</span>
        {href && <a className="ml-auto text-faint hover:text-fg" href={href}>{at ? ago(at) : 'live'} ↗</a>}
      </div>
      {children}
    </div>
  );
}

function IdeaCard({ i, who, onDone }: { i: any; who: (id: string) => any; onDone: () => void }) {
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const act = async (d: 'approve' | 'reject') => { setBusy(true); setErr(''); try { await api('POST', `/api/ideas/${i.id}/${d}`); onDone(); } catch (e) { setErr((e as Error).message); } setBusy(false); };
  const a = i.assignee_id ? who(i.assignee_id) : null;
  return (
    <div className={`rounded-lg border p-3 ${i.status === 'approved' ? 'border-matcha/40' : i.status === 'rejected' ? 'border-line opacity-50' : 'border-line-strong'}`}>
      <div className="text-[13px] font-medium">{i.title}</div>
      {i.description && <div className="mt-1 whitespace-pre-wrap text-[12px] text-dim">{i.description}</div>}
      {i.why && <div className="mt-1 text-[11.5px] text-faint">เหตุผล: {i.why}</div>}
      <div className="mt-2 flex items-center gap-2 text-[11px]">
        <span className="text-faint">ผู้รับผิดชอบที่เสนอ: {a ? a.role : 'ให้ CEO เลือก'}</span>
        <span className="ml-auto" />
        {i.status === 'pending' && <>
          <button className="btn btn-primary h-7" disabled={busy} onClick={() => act('approve')}>✓ อนุมัติ → สร้างงาน</button>
          <button className="btn h-7" disabled={busy} onClick={() => act('reject')}>ไม่เอา</button>
        </>}
        {i.status === 'approved' && <a className="text-matcha hover:underline" href={`#/tasks/${i.task_id}`}>✓ อนุมัติแล้ว · ดูงาน</a>}
        {i.status === 'rejected' && <span className="text-faint">ไม่เอา</span>}
      </div>
      {err && <div className="mt-1 text-[11.5px] text-shu">{err}</div>}
    </div>
  );
}
