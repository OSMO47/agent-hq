import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, useResource, useLive, ago } from '../api';
import { Empty } from '../ui';
import { Markdown } from '../Markdown';
import './meeting-room.css';

const STATUS: Record<string, [string, string]> = {
  running: ['กำลังประชุม', 'text-kin'], summarizing: ['CEO กำลังสรุป', 'text-kin'], done: ['เสร็จแล้ว', 'text-matcha'],
  stopped: ['หยุดแล้ว', 'text-faint'], failed: ['ล้มเหลว', 'text-shu'],
  selecting: ['CEO กำลังเลือกผู้เข้าประชุม', 'text-kin'], proposed: ['รออนุมัติรายชื่อ', 'text-accent'],
};
/** สีประจำที่นั่ง (วนใช้ตามลำดับผู้เข้าประชุม) */
// Mid-tone hues: readable as text and rings on both the light (Chiikawa) and the dark themes.
const HUES = ['#4f7fd1', '#4f9a3c', '#cf5a9e', '#d07c22', '#2f9aa3', '#8a62d6'];
const CEO_POS = { x: 380, y: 70 };

/** วางที่นั่ง n คนบนครึ่งล่างของวงรีรอบโต๊ะ */
function seatPos(i: number, n: number) {
  const deg = n === 1 ? 90 : 165 - (i * 150) / (n - 1);
  const t = (deg * Math.PI) / 180;
  return { x: Math.round(380 + 260 * Math.cos(t)), y: Math.round(200 + 110 * Math.sin(t)) };
}
const initials = (s?: string) => (s ?? '?').replace(/[^A-Za-z0-9ก-๙]/g, ' ').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase();

/** Idea meeting room: list of meetings on the left, the selected meeting (or a new one) on the right. */
export default function Meetings({ param }: { param?: string }) {
  const list = useResource<any[]>('/api/meetings', ['meeting']);
  const sel = param ?? list.data?.[0]?.id ?? 'new';
  return (
    <div className="mr-root grid h-full grid-cols-[300px_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col border-r border-line">
        <div className="p-3"><a className="btn btn-primary w-full" href="#/meetings/new">＋ ประชุมใหม่</a></div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {list.data?.length === 0 && <Empty>ยังไม่มีการประชุม</Empty>}
          {list.data?.map((m) => {
            const [label, tone] = STATUS[m.status] ?? [m.status, 'text-dim'];
            const running = ['running', 'summarizing', 'selecting'].includes(m.status);
            return (
              <a key={m.id} href={`#/meetings/${m.id}`}
                className={`mr-msg block border-b border-l-2 border-line/60 px-4 py-2.5 transition-colors ${m.id === sel ? 'border-l-accent bg-raise' : 'border-l-transparent hover:bg-raise/50'}`}>
                <div className="line-clamp-2 text-[12.5px] leading-snug">{m.topic}</div>
                <div className="mt-1 flex items-center gap-2 text-[10.5px]">
                  <span className={`inline-flex items-center gap-1.5 ${tone}`}>{running && <span className="mr-livedot" />}{label}</span>
                  {m.pending > 0 && <span className="pill text-accent">{m.pending} ไอเดียรออนุมัติ</span>}
                  <span className="ml-auto text-faint">{ago(m.created_at)}</span>
                </div>
                <div className="mt-0.5 truncate text-[10.5px] text-faint">{m.project_name}</div>
              </a>
            );
          })}
        </div>
      </div>
      {sel === 'new' ? <NewMeeting /> : sel.startsWith('plan_') ? <Plan key={sel} id={sel} /> : <Room key={sel} id={sel} />}
    </div>
  );
}

function NewMeeting() {
  const projects = useResource<any[]>('/api/projects', ['project']);
  const org = useResource<{ departments: any[]; agents: any[] }>('/api/org', ['org']);
  const [topic, setTopic] = useState(''); const [pid, setPid] = useState('');
  const [isNew, setIsNew] = useState(false); const [pname, setPname] = useState(''); const [ppath, setPpath] = useState('');
  const [rounds, setRounds] = useState(2);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (!pid && projects.data?.[0]) setPid(projects.data[0].id); }, [projects.data, pid]);
  if (!org.data || !projects.data) return <Empty>Loading…</Empty>;
  const newMode = isNew || projects.data.length === 0;

  return (
    <div className="min-h-0 overflow-y-auto">
      <form className="mx-auto max-w-[760px] space-y-5 p-6" onSubmit={async (e) => {
        e.preventDefault(); setErr(''); setBusy(true);
        try {
          let projectId = pid;
          if (newMode) {
            const p = await api('POST', '/api/projects', { name: pname.trim(), repoPath: ppath.trim() || null });
            projectId = p.id;
          }
          const m = await api('POST', '/api/meetings', { projectId, topic, rounds });
          location.hash = `#/meetings/${m.id}`;
        }
        catch (x) { setErr((x as Error).message); setBusy(false); }
      }}>
        <div>
          <div className="text-[15px] font-semibold">ห้องประชุมเสนอไอเดีย</div>
          <div className="mt-1 text-[12px] leading-relaxed text-dim">
            ตั้งหัวข้อ แล้ว CEO จะเลือกคนที่เกี่ยวข้องมาเข้าประชุมและส่งรายชื่อให้คุณตรวจ (อนุมัติหรือเพิ่ม/ลดคนได้) จากนั้นทีมจะผลัดกันเสนอไอเดียทีละคน แต่ละคนเห็นสิ่งที่คนก่อนพูดและเปิดดูโค้ดได้ (อ่านอย่างเดียว ไม่แก้ไฟล์)
            จบแล้ว CEO สรุปไอเดียที่ดีที่สุดเป็นการ์ด คุณกด <span className="text-matcha">อนุมัติ</span> ข้อไหน ข้อนั้นจะกลายเป็นงานให้ทีมทำต่อเอง
          </div>
        </div>
        <label className="block space-y-1"><span className="label">หัวข้อ / โจทย์</span>
          <textarea className="field" rows={4} required autoFocus value={topic} onChange={(e) => setTopic(e.target.value)}
            placeholder="เช่น ทำยังไงให้ผู้เรียน N5 กลับมาเรียนทุกวัน โดยไม่ต้องเพิ่มเนื้อหาใหม่" /></label>
        <div className="space-y-2">
          <span className="label">โปรเจกต์ (ไอเดียที่อนุมัติจะเป็นงานในโปรเจกต์นี้)</span>
          <div className="flex gap-2">
            {[[false, 'เลือกโปรเจกต์ที่มีอยู่'], [true, '＋ โปรเจกต์ใหม่']].map(([v, l]) => (
              <button type="button" key={String(v)} disabled={!v && projects.data!.length === 0} onClick={() => setIsNew(v as boolean)}
                className={`rounded-md border px-3 py-1 text-[12px] disabled:opacity-40 ${newMode === v ? 'border-accent text-accent' : 'border-line text-dim hover:border-line-strong'}`}>{l as string}</button>
            ))}
          </div>
          {newMode ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <input className="field" required value={pname} onChange={(e) => setPname(e.target.value)} placeholder="ชื่อโปรเจกต์ใหม่" />
              <input className="field" value={ppath} onChange={(e) => setPpath(e.target.value)} placeholder="โฟลเดอร์ (ไม่บังคับ — เว้นว่าง = สร้างโฟลเดอร์ว่างให้)" />
            </div>
          ) : (
            <select className="field" value={pid} onChange={(e) => setPid(e.target.value)}>{projects.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className="label">จำนวนรอบ</span>
          {[1, 2, 3].map((r) => (
            <button type="button" key={r} onClick={() => setRounds(r)}
              className={`rounded-md border px-3 py-1 text-[12px] ${rounds === r ? 'border-accent text-accent' : 'border-line text-dim hover:border-line-strong'}`}>{r}</button>
          ))}
          <span className="text-[11px] text-faint">รอบแรกเสนอไอเดีย รอบถัดไปต่อยอด/แย้งกัน</span>
        </div>
        {err && <div className="text-[12px] text-shu">{err}</div>}
        <button className="btn btn-primary h-9 px-5" disabled={busy || !topic.trim() || (newMode && !pname.trim())}>◎ ให้ CEO เลือกผู้เข้าประชุม</button>
      </form>
    </div>
  );
}

/** CEO proposed attendees → owner reviews: keep, remove, or add people, then approve to start. */
/** Long briefs (pasted specs) must not push the table off screen: show 2 lines, expand on click. */
function Topic({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 160 || text.split('\n').length > 2;
  return (
    <div>
      <div className={`whitespace-pre-wrap text-[14px] font-semibold leading-snug ${open ? 'max-h-[40vh] overflow-y-auto' : 'line-clamp-2'}`}>{text}</div>
      {long && <button type="button" className="mt-0.5 text-[11px] text-accent hover:underline" onClick={() => setOpen(!open)}>{open ? 'ย่อหัวข้อ ▲' : 'ดูหัวข้อทั้งหมด ▼'}</button>}
    </div>
  );
}

/** CEO proposed attendees → owner reviews. (see Plan below) */
function Plan({ id }: { id: string }) {
  const { data } = useResource<any>(`/api/meetings/${id}`, ['meeting']);
  const org = useResource<{ departments: any[]; agents: any[] }>('/api/org', ['org']);
  const [people, setPeople] = useState<string[] | null>(null);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (data?.plan.status === 'proposed' && people === null) setPeople(data.suggested.map((x: any) => x.id)); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data || !org.data) return <Empty>Loading…</Empty>;
  const p = data.plan;
  const why: Record<string, string> = Object.fromEntries(data.suggested.map((x: any) => [x.id, x.why]));
  const [label, tone] = STATUS[p.status] ?? [p.status, 'text-dim'];
  const sel = people ?? [];
  const toggle = (aid: string) => setPeople((cur) => { const c = cur ?? []; return c.includes(aid) ? c.filter((x) => x !== aid) : c.length >= 6 ? c : [...c, aid]; });
  const groups = org.data.departments
    .map((d) => ({ d, agents: org.data!.agents.filter((a) => a.department_id === d.id && a.status === 'active' && a.id !== 'ceo').sort((a, b) => a.level - b.level) }))
    .filter((g) => g.agents.length);
  const go = async (path: string, body?: any) => {
    setBusy(true); setErr('');
    try { const r = await api('POST', path, body); location.hash = path.endsWith('/approve') ? `#/meetings/${r.id}` : '#/meetings/new'; }
    catch (x) { setErr((x as Error).message); setBusy(false); }
  };
  return (
    <div className="min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-[760px] space-y-4 p-6">
        <div>
          <Topic text={p.topic} />
          <div className="mt-1 flex items-center gap-2 text-[11px]">
            <span className={`inline-flex items-center gap-1.5 ${tone}`}>{p.status === 'selecting' && <span className="mr-livedot" />}{label}</span>
            <span className="text-faint">· {p.project_name} · {p.rounds} รอบ</span>
          </div>
        </div>
        {p.status === 'selecting' && (
          <div className="mr-msg flex items-center gap-3 rounded-lg border border-kin/40 px-3 py-2.5 text-[12px] text-kin">
            <span className="mr-dots"><i /><i /><i /></span>CEO กำลังดูหัวข้อและเลือกคนที่เกี่ยวข้อง…
            <button className="btn ml-auto h-8 px-3" disabled={busy} onClick={() => go(`/api/meeting-plans/${id}/cancel`)}>ยกเลิก</button>
          </div>
        )}
        {p.status === 'failed' && <div className="mr-msg text-[12px] text-shu">CEO เลือกรายชื่อไม่สำเร็จ <a className="underline" href="#/meetings/new">ลองใหม่</a></div>}
        {p.status === 'proposed' && (
          <>
            <div className="mr-msg rounded-lg border border-accent/40 bg-accent/[.05] p-3 text-[12px] leading-relaxed">
              <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-accent">CEO เลือกคนเหล่านี้มาประชุม</div>
              {data.suggested.map((x: any, i: number) => {
                const a = org.data!.agents.find((y) => y.id === x.id);
                return <div key={x.id} className="mr-msg" style={{ animationDelay: `${0.2 + i * 0.12}s` }}>• <b>{a?.name ?? x.id}</b> <span className="text-faint">{a?.title ?? a?.role}</span>{x.why && <span className="text-dim"> — {x.why}</span>}</div>;
              })}
              {p.note && <div className="mr-msg mt-1.5 text-dim" style={{ animationDelay: `${0.2 + data.suggested.length * 0.12}s` }}>หมายเหตุจาก CEO: {p.note}</div>}
            </div>
            <div className="flex items-baseline justify-between">
              <span className="label">ผู้เข้าประชุม (2-6 คน) · กดเพิ่ม/เอาออกได้</span>
              <span className="text-[11px] text-faint">เลือกแล้ว {sel.length}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
              {groups.map(({ d, agents }, gi) => (
                <div key={d.id} className="mr-msg rounded-lg border border-line p-2" style={{ animationDelay: `${0.35 + gi * 0.05}s` }}>
                  <div className="mb-1 px-1 text-[10.5px] uppercase tracking-wider text-faint">{d.name}</div>
                  {agents.map((a) => {
                    const on = sel.includes(a.id);
                    return (
                      <button type="button" key={a.id} onClick={() => toggle(a.id)} title={why[a.id]}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11.5px] transition-colors ${on ? 'bg-accent/15 text-fg' : 'text-dim hover:bg-raise'}`}>
                        <span className={`grid size-3.5 shrink-0 place-items-center rounded border text-[9px] ${on ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong'}`}>{on ? '✓' : ''}</span>
                        <span className="truncate">{a.name === a.role ? a.role : `${a.name} · ${a.title ?? a.role}`}</span>
                        {why[a.id] !== undefined && <span className="chip ml-auto text-kin">CEO</span>}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            {err && <div className="text-[12px] text-shu">{err}</div>}
            <div className="flex gap-2">
              <button className="btn btn-primary h-9 px-5" disabled={busy || sel.length < 2 || sel.length > 6}
                onClick={() => go(`/api/meeting-plans/${id}/approve`, { participants: sel })}>✓ อนุมัติ → เริ่มประชุม</button>
              <button className="btn h-9 px-4" disabled={busy} onClick={() => go(`/api/meeting-plans/${id}/cancel`)}>ยกเลิก</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

type Phase = 'idle' | 'queued' | 'thinking' | 'speaking';

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

  // รอบปัจจุบัน → แสดงป้าย "รอบ N" ตอนเปลี่ยนรอบ
  const people: string[] = data ? JSON.parse(data.meeting.participants) : [];
  const nMsgs: number = data?.messages?.length ?? 0;
  const roundNow = people.length ? Math.min(data.meeting.rounds, Math.floor(nMsgs / people.length) + 1) : 1;
  const [banner, setBanner] = useState(0);
  const prevRound = useRef(roundNow);
  useEffect(() => {
    const prev = prevRound.current; prevRound.current = roundNow;
    if (roundNow > prev && data?.meeting?.status === 'running') {
      setBanner(roundNow);
      const t = setTimeout(() => setBanner(0), 2100);
      return () => clearTimeout(t);
    }
  }, [roundNow]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <Empty>Loading…</Empty>;
  const m = data.meeting;
  const who = (aid: string) => org.data?.agents.find((a) => a.id === aid);
  const [label, tone] = STATUS[m.status] ?? [m.status, 'text-dim'];
  const active = ['running', 'summarizing'].includes(m.status);
  const summarizing = m.status === 'summarizing';
  // ใครกำลังพูด: ถ้า backend ส่ง agent_id มากับ current ใช้อันนั้น ไม่งั้นเทียบจากชื่อ
  const speakerId: string | null = !active || !data.current ? null
    : summarizing ? 'ceo'
    : data.current.agent_id ?? org.data?.agents.find((a) => a.name === data.current.name)?.id ?? null;
  const phase: Phase = !active || !data.current ? 'idle' : data.current.status === 'queued' ? 'queued' : live ? 'speaking' : 'thinking';
  let lastRound = 0;

  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      <div className="shrink-0 border-b border-line px-5 py-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <Topic text={m.topic} />
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
              <span className={`inline-flex items-center gap-1.5 ${tone}`}>{active && <span className="mr-livedot" />}{label}{active && !summarizing ? ` · รอบ ${roundNow}` : ''}</span>
              <span className="text-faint">· {m.project_name} · {m.rounds} รอบ ·</span>
              {people.map((p, i) => <span key={p} className="chip" style={{ color: HUES[i % HUES.length] }}>{who(p)?.name ?? p}</span>)}
              <span className="chip text-kin">CEO ประธาน</span>
            </div>
          </div>
          {active && <button className="btn btn-danger" onClick={() => api('POST', `/api/meetings/${id}/stop`).then(reload)}>■ หยุดประชุม</button>}
        </div>
      </div>

      <div ref={box} className="min-h-0 flex-1 overflow-y-auto">
        <div className="border-b border-line bg-panel/40">
          <Stage people={people} who={who} speakerId={speakerId} phase={phase} live={live} banner={banner} />
          <RoundProgress people={people} rounds={m.rounds} done={nMsgs} ended={m.status === 'done'} who={who} />
        </div>

        <div className="space-y-4 px-5 py-5">
          {data.messages.map((x: any) => {
            const sep = x.round !== lastRound; lastRound = x.round;
            const idx = people.findIndex((p) => p === x.agent_id || who(p)?.name === x.name);
            return (
              <div key={x.id} className="mr-msg">
                {sep && <div className="mb-3 flex items-center gap-3 text-[10.5px] uppercase tracking-wider text-faint"><span className="h-px flex-1 bg-line" />รอบ {x.round}<span className="h-px flex-1 bg-line" /></div>}
                <Bubble name={x.name} role={x.role} hue={idx >= 0 ? HUES[idx % HUES.length] : undefined} at={x.created_at} href={x.session_id ? `#/sessions/${x.session_id}` : undefined}><Markdown text={x.body} /></Bubble>
              </div>
            );
          })}

          {active && data.current && (
            <Bubble name={data.current.name} role={summarizing ? 'ประธาน กำลังสรุป' : data.current.role} live href={`#/sessions/${data.current.id}`}>
              {live
                ? <div><Markdown text={live} /><span className="mr-caret text-kin" /></div>
                : <div className="flex items-center gap-2 text-[12px] text-kin"><span className="mr-dots"><i /><i /><i /></span>{data.current.status === 'queued' ? 'รอคิว…' : 'กำลังคิด / อ่านโค้ด…'}</div>}
            </Bubble>
          )}

          {m.summary && (
            <div className="mr-msg rounded-xl border border-accent/40 bg-accent/[.06] p-4">
              <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-accent">สรุปจาก CEO</div>
              <Markdown text={m.summary} />
            </div>
          )}
          {data.ideas.length > 0 && (
            <div className="space-y-5 pt-2">
              <div className="label">ไอเดียที่เสนอ · กดอนุมัติ = สร้างเป็นงานให้ทีมทำ</div>
              {data.ideas.map((i: any, idx: number) => <IdeaCard key={i.id} i={i} idx={idx} who={who} onDone={reload} />)}
            </div>
          )}
          {m.status === 'failed' && <div className="text-[12px] text-shu">การประชุมหยุดเพราะมีคนตอบไม่สำเร็จ ดูรายละเอียดได้ที่ Live sessions</div>}
        </div>
      </div>
    </div>
  );
}

/** เวทีโต๊ะประชุม: ที่นั่ง + สปอตไลต์ + bubble + ป้ายรอบ */
function Stage({ people, who, speakerId, phase, live, banner }: {
  people: string[]; who: (id: string) => any; speakerId: string | null; phase: Phase; live: string; banner: number;
}) {
  const seats = [
    ...people.map((aid, i) => ({ aid, ...seatPos(i, people.length), name: who(aid)?.name ?? aid, role: who(aid)?.title ?? who(aid)?.role ?? '', hue: HUES[i % HUES.length] })),
    { aid: 'ceo', ...CEO_POS, name: who('ceo')?.name ?? 'CEO', role: 'ประธาน · สรุป', hue: 'var(--mr-accent)' },
  ];
  const sp = seats.find((s) => s.aid === speakerId);
  const tail = live.length > 74 ? '…' + live.slice(-74) : live;

  return (
    <div className="overflow-x-auto">
      <div className="mr-stage">
        <div className="mr-spot" style={{ left: (sp?.x ?? CEO_POS.x) - 130, top: (sp?.y ?? CEO_POS.y) - 130, opacity: sp && phase !== 'queued' ? 1 : 0 }} />
        <div className="mr-table"><span className="text-[10.5px] tracking-[.14em] text-faint">โต๊ะประชุม · 会議</span></div>

        {seats.map((s, si) => {
          const isCur = s.aid === speakerId;
          const st: Phase = isCur ? phase : 'idle';
          const dim = !!speakerId && !isCur && phase === 'speaking';
          return (
            <div key={s.aid} className={`mr-seat ${st} ${dim ? 'dim' : ''}`} style={{ left: s.x - 36, top: s.y - 36, '--hue': s.hue, animationDelay: `${si * 0.08}s` } as CSSProperties}>
              <div className="mr-av">
                {who(s.aid)?.avatar != null
                  ? <img src={`/api/agents/${encodeURIComponent(s.aid)}/avatar?v=${who(s.aid).avatar}`} alt={s.name} className="size-full object-cover" draggable={false} />
                  : initials(s.name)}
              </div>
              <div className="mr-nm">
                <div className="truncate text-[12px] font-semibold text-fg">{s.name}</div>
                <div className="truncate font-mono text-[10px] text-faint">{s.role}</div>
              </div>
              {st === 'queued' && <div className="mr-qchip">รอคิว…</div>}
              {st === 'thinking' && (
                <div className="mr-think">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /></svg>
                  {s.aid === 'ceo' ? 'อ่านบันทึกทั้งหมด' : 'กำลังอ่านโค้ด'}<span className="mr-dots"><i /><i /><i /></span>
                </div>
              )}
              {st === 'speaking' && (
                <>
                  <div className="mr-wave"><i /><i /><i /><i /><i /></div>
                  <div className={`mr-bubble ${s.aid === 'ceo' ? 'side' : ''}`}>{tail}<span className="mr-caret" /></div>
                </>
              )}
            </div>
          );
        })}

        {banner > 0 && (
          <div key={banner} className="mr-banner">
            <div className="flex items-baseline gap-3.5 rounded-xl border border-kin bg-panel px-7 py-3 shadow-2xl">
              <span className="text-[30px] font-bold text-kin">รอบ {banner}</span>
              <span className="text-[13px] text-dim">ต่อยอด / แย้งกัน</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** แถบความคืบหน้า: จุดละคน ต่อรอบ + จุดสรุปของ CEO */
function RoundProgress({ people, rounds, done, ended, who }: { people: string[]; rounds: number; done: number; ended: boolean; who: (id: string) => any }) {
  if (!people.length) return null;
  const total = people.length * rounds + 1;
  const cur = ended ? total : Math.min(done, total - 1);
  const steps = [
    ...Array.from({ length: rounds }, (_, r) => people.map((aid, i) => ({ key: `${r}-${aid}`, ini: initials(who(aid)?.name ?? aid), hue: HUES[i % HUES.length] }))).flat(),
    { key: 'ceo', ini: initials(who('ceo')?.name ?? 'CEO'), hue: 'var(--mr-accent)' },
  ];
  return (
    <div className="border-t border-line px-6 pb-6 pt-3.5">
      <div className="relative mx-auto grid max-w-[760px] gap-y-2.5" style={{ gridTemplateColumns: `repeat(${total}, minmax(0, 1fr))` }}>
        {Array.from({ length: rounds }, (_, r) => (
          <div key={r} className="text-center text-[10.5px] tracking-wide text-faint" style={{ gridColumn: `span ${people.length}` }}>
            รอบ {r + 1} · {r === 0 ? 'เสนอไอเดีย' : 'ต่อยอด / แย้ง'}
          </div>
        ))}
        <div className="text-center text-[10.5px] tracking-wide text-faint">สรุป</div>
        <div className="absolute inset-x-[4%] bottom-[13px] h-px bg-line" />
        {steps.map((s, i) => (
          <div key={s.key} className="relative flex justify-center">
            <div className={`mr-step ${i < cur ? 'done' : i === cur ? 'cur' : ''}`} style={{ '--hue': s.hue } as CSSProperties}>{s.ini}</div>
          </div>
        ))}
        <div className="mr-marker" style={{ left: `calc(${((Math.min(cur, total - 1) + 0.5) / total) * 100}% - 14px)` }} />
      </div>
    </div>
  );
}

function Bubble({ name, role, at, live, href, hue, children }: { name: string; role: string; at?: string; live?: boolean; href?: string; hue?: string; children: ReactNode }) {
  return (
    <div className={`rounded-xl border px-4 py-3 ${live ? 'border-kin/40' : 'border-line bg-panel'}`}>
      <div className="mb-1.5 flex items-center gap-2 text-[11px]">
        {hue && <span className="size-2 rounded-full" style={{ background: hue }} />}
        <span className={hue ? 'font-semibold' : 'text-ai'} style={hue ? { color: hue } : undefined}>{name}</span><span className="text-faint">{role}</span>
        {href && <a className="ml-auto text-faint hover:text-fg" href={href}>{at ? ago(at) : 'live'} ↗</a>}
      </div>
      {children}
    </div>
  );
}

/** การ์ดไอเดียแบบโพสต์อิท: บินเข้า · อนุมัติ = พลิก + ตราประทับ + ชิปบินไปหางาน · ไม่เอา = ยับแล้วจาง */
function IdeaCard({ i, idx, who, onDone }: { i: any; idx: number; who: (id: string) => any; onDone: () => void }) {
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const [anim, setAnim] = useState<'' | 'approved' | 'rejected'>('');
  const act = async (d: 'approve' | 'reject') => {
    setBusy(true); setErr('');
    try {
      await api('POST', `/api/ideas/${i.id}/${d}`);
      setAnim(d === 'approve' ? 'approved' : 'rejected');
      setTimeout(onDone, 1500); // ให้อนิเมชั่นเล่นจบก่อนค่อย reload
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  const a = i.assignee_id ? who(i.assignee_id) : null;
  const approved = anim === 'approved' || i.status === 'approved';
  const rejected = anim === 'rejected' || i.status === 'rejected';
  const cls = anim || (i.status === 'pending' ? 'fly' : i.status === 'rejected' ? 'was-rejected' : '');
  const rot = [-1.6, 1.1, -0.6, 0.8][idx % 4];

  return (
    <div className={`mr-idea ${cls}`} style={{ '--rot': `${rot}deg`, animationDelay: `${0.2 + idx * 0.45}s` } as CSSProperties}>
      <div className="pr-[70px] text-[14px] font-semibold">{i.title}</div>
      {i.description && <div className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-[#4a4130]">{i.description}</div>}
      {i.why && <div className="mt-1 text-[11.5px] text-[#5b5140]">เหตุผล: {i.why}</div>}
      <div className="mt-1.5 text-[11px] text-[#5b5140]">ผู้รับผิดชอบที่เสนอ: {a ? a.role : 'ให้ CEO เลือก'}</div>

      {!approved && !rejected && (
        <div className="mt-2.5 flex gap-2">
          <button className="h-8 rounded-lg bg-[#2b6b3a] px-3 text-[12px] font-semibold text-white disabled:opacity-60" disabled={busy} onClick={() => act('approve')}>✓ อนุมัติ → สร้างงาน</button>
          <button className="h-8 rounded-lg border border-[#8a7d5c] px-3 text-[12px] text-[#4a4130] disabled:opacity-60" disabled={busy} onClick={() => act('reject')}>ไม่เอา</button>
        </div>
      )}
      {approved && (
        <>
          <div className={`mr-stamp ${anim ? 'anim' : ''}`}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>
            <span>อนุมัติ</span>
          </div>
          <div className="mt-2.5 text-[12px] font-semibold text-[#2b6b3a]">
            ✓ อนุมัติแล้ว{i.task_id && <> · <a className="text-[#2b6b3a] underline" href={`#/tasks/${i.task_id}`}>ดูงาน</a></>}
          </div>
          {anim && <div className="mr-ghost font-mono">→ งานใหม่</div>}
        </>
      )}
      {rejected && <div className="mt-2.5 text-[12px] text-[#4a4130]">ไม่เอา · ข้อนี้จะไม่กลายเป็นงาน</div>}
      {err && <div className="mt-1 text-[11.5px] text-shu">{err}</div>}
    </div>
  );
}
