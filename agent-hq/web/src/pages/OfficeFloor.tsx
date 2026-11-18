import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react';
import './office.css';

/* ข้อมูลที่ใช้ — ตรงกับ /api/org และ /api/sessions */
export type OfficeAgent = { id: string; name: string; role: string; department_id: string; level?: number; status?: string };
export type OfficeDept = { id: string; name: string };
export type OfficeSession = { id: string; agent_id?: string; agent_name?: string; status: string; task_title?: string | null; purpose?: string; queued_at?: string };

/** พิกัดในห้อง (หน่วยเป็น px ของผังขนาด 1000×560) · aisle = ทางเดินแนวนอนที่จุดนี้ใช้ออกไปยังทางเดินหลัก */
type Pt = { x: number; y: number; aisle: number };
type Spot = Pt & { id: string; label: string; icon: string; sleep?: boolean };

const W = 1000, H = 560;
const SPINE = 648;           // ทางเดินแนวตั้งระหว่างโซนโต๊ะกับห้องฝั่งขวา
const MS_PER_PX = 4.2;       // ความเร็วเดิน
const DEPT_HUES = ['#7fa3e6', '#8fbf6a', '#e391c2', '#e6a15a', '#9ad0d4', '#c7a6f0', '#e0b54a', '#f08a74'];
const ACTIVE = ['running', 'queued'];
const isCeo = (a: OfficeAgent) => /\bceo\b/i.test(a.role) || /\bceo\b/i.test(a.name);

/* จุดที่คนว่างไปทำอย่างอื่นได้ (ในห้องพักผ่อน) */
const LOUNGE: Spot[] = [
  { id: 'coffee', x: 712, y: 338, aisle: 338, label: 'ชงกาแฟ', icon: '☕' },
  { id: 'cooler', x: 772, y: 338, aisle: 338, label: 'คุยข้างตู้น้ำ', icon: '💬' },
  { id: 'shelf', x: 925, y: 338, aisle: 338, label: 'อ่านหนังสือ', icon: '📖' },
  { id: 'plant', x: 716, y: 430, aisle: 430, label: 'รดน้ำต้นไม้', icon: '🪴' },
  { id: 'chat1', x: 800, y: 418, aisle: 418, label: 'ยืนคุยกัน', icon: '💬' },
  { id: 'chat2', x: 846, y: 418, aisle: 418, label: 'ยืนคุยกัน', icon: '😄' },
  { id: 'game', x: 930, y: 452, aisle: 452, label: 'เล่นเกม', icon: '🎮' },
  { id: 'sofa1', x: 742, y: 503, aisle: 476, label: 'งีบ', icon: '', sleep: true },
  { id: 'sofa2', x: 792, y: 503, aisle: 476, label: 'ไถมือถือ', icon: '📱' },
  { id: 'sofa3', x: 842, y: 503, aisle: 476, label: 'ฟังเพลง', icon: '🎧' },
  { id: 'stretch', x: 930, y: 512, aisle: 512, label: 'ยืดเส้น', icon: '🙆' },
];
const CEO_SEAT: Pt = { x: 825, y: 168, aisle: 205 };
const CEO_IDLE: Spot[] = [
  { id: 'ceo-window', x: 925, y: 100, aisle: 205, label: 'มองวิว', icon: '🌆' },
  { id: 'ceo-phone', x: 712, y: 205, aisle: 205, label: 'โทรคุยงาน', icon: '📞' },
];

type Desk = { agentId: string; x: number; tableY: number; w: number; seat: Pt; hue: string };
type Layout = { desks: Map<string, Desk>; labels: { name: string; x: number; y: number }[]; hues: Map<string, string>; spots: Spot[]; ceoId?: string };

function buildLayout(depts: OfficeDept[], agents: OfficeAgent[]): Layout {
  const live = agents.filter((a) => (a.status ?? 'active') === 'active');
  const ceo = live.find(isCeo);
  const rows = depts
    .map((d, i) => ({ d, hue: DEPT_HUES[i % DEPT_HUES.length], members: live.filter((a) => a.department_id === d.id && a !== ceo).sort((a, b) => (a.level ?? 0) - (b.level ?? 0)) }))
    .filter((r) => r.members.length > 0);
  const cols = rows.length > 4 ? 2 : 1;
  const perCol = Math.max(1, Math.ceil(rows.length / cols));
  const x0 = 28, x1 = 622, y0 = 40, y1 = 548;
  const colW = (x1 - x0) / cols, rowH = (y1 - y0) / perCol;
  const desks = new Map<string, Desk>(); const labels: Layout['labels'] = []; const hues = new Map<string, string>();

  rows.forEach((r, k) => {
    const colX = x0 + Math.floor(k / perCol) * colW;
    const top = y0 + (k % perCol) * rowH;
    const n = r.members.length;
    const tableY = top + rowH * 0.3, seatY = top + rowH * 0.72, aisle = top + rowH * 0.95;
    labels.push({ name: r.d.name, x: colX + 2, y: top });
    r.members.forEach((a, i) => {
      const x = colX + (colW * (i + 0.5)) / n;
      hues.set(a.id, r.hue);
      desks.set(a.id, { agentId: a.id, x, tableY, w: Math.min(74, colW / n - 12), seat: { x, y: seatY, aisle }, hue: r.hue });
    });
  });
  if (ceo) {
    hues.set(ceo.id, '#e0b54a');
    desks.set(ceo.id, { agentId: ceo.id, x: CEO_SEAT.x, tableY: 112, w: 96, seat: CEO_SEAT, hue: '#e0b54a' });
  }
  // ห้องพักรับได้เท่าจำนวนจุดที่มี: คนว่างที่เหลือนั่งพักที่โต๊ะตัวเอง (assign ไม่ได้จุด → กลับโต๊ะ)
  // เดิมสร้างจุดยืนเพิ่มจนทุกคนได้ที่ ทำให้ 20+ คนอัดกันในห้องพักและหลุดออกนอกพื้นห้อง
  // การสุ่มย้ายทุก 4.2 วินาทียังหมุนเวียนคนระหว่างโต๊ะกับห้องพักได้ เพราะย้ายได้เฉพาะไปจุดที่ว่าง
  const spots = [...LOUNGE];
  return { desks, labels, hues, spots, ceoId: ceo?.id };
}

/** เส้นทางเดิน: ออกทางเดินของตัวเอง → ทางเดินหลักแนวตั้ง → ทางเดินของปลายทาง → ปลายทาง */
function route(from: Pt, to: Pt): Pt[] {
  const pts: Pt[] = Math.abs(from.aisle - to.aisle) < 2
    ? [{ x: from.x, y: from.aisle, aisle: from.aisle }, { x: to.x, y: to.aisle, aisle: to.aisle }, to]
    : [
      { x: from.x, y: from.aisle, aisle: from.aisle },
      { x: SPINE, y: from.aisle, aisle: from.aisle },
      { x: SPINE, y: to.aisle, aisle: to.aisle },
      { x: to.x, y: to.aisle, aisle: to.aisle },
      to,
    ];
  const out: Pt[] = []; let prev = from;
  for (const p of pts) { if (Math.hypot(p.x - prev.x, p.y - prev.y) > 2) { out.push(p); prev = p; } }
  return out;
}


/* ---------- ตัวการ์ตูนจิบิ ---------- */
const SKINS = ['#f8dfc8', '#f1cfae', '#e2b28c', '#c98f68'];
const HAIRS = ['#3b2a20', '#1f1b24', '#7a4a2b', '#c98b4a', '#e8c47c', '#5a6b8c', '#b05a7a', '#3f5a45', '#d9d4cc'];
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

/** ผม 6 ทรง วาดทับหัว (หัวอยู่ที่ 20,18 รัศมี 13) · back = ส่วนที่อยู่หลังหัว */
const HAIR_STYLES: { back?: string; front: string; extra?: (c: string) => JSX.Element }[] = [
  { front: 'M7 21 C6 9 12 4 20 4 C28 4 34 9 33 21 C31 17 30 14 27 11.5 C22 14.5 15 14.5 12.5 11.5 C10 14 9 17 7 21 Z' },               // บ๊อบ
  { front: 'M8 16 L9.5 8 L13 11 L14.5 4.5 L18.5 9 L21.5 3.5 L24.5 9 L28 5 L29 11 L32.5 9 L32 16.5 C28 11.5 12 11.5 8 16 Z' },        // ผมตั้ง
  { front: 'M8 16.5 C8 7.5 14 4.5 20 4.5 C26 4.5 32 7.5 32 16.5 C27 11.5 13 11.5 8 16.5 Z', extra: (c) => <circle cx="20" cy="3.6" r="4.2" fill={c} /> }, // มวยจุก
  { front: 'M8 16.5 C8 7.5 14 4.5 20 4.5 C26 4.5 32 7.5 32 16.5 C27 11.5 13 11.5 8 16.5 Z',
    extra: (c) => <><circle cx="6" cy="19" r="4" fill={c} /><circle cx="34" cy="19" r="4" fill={c} /></> },                                // แกละ
  { front: 'M8 17 C7.5 7 15 3.5 22 4.2 C28.5 5 33 9.5 32 17.5 C29 12 24 9.5 17 12.5 C13 14 10.5 15.5 8 17 Z' },                        // แสกข้าง
  { back: 'M7.5 16 C7.5 6 32.5 6 32.5 16 L33.5 33 C30 35 10 35 6.5 33 Z',
    front: 'M8 17 C8 7.5 14 4.5 20 4.5 C26 4.5 32 7.5 32 17 C28 13 24 11 20 11 C16 11 12 13 8 17 Z' },                                   // ยาว
];

function Chibi({ seed, hue, ceo, sleeping }: { seed: string; hue: string; ceo?: boolean; sleeping?: boolean }) {
  const h = hash(seed);
  const skin = SKINS[h % SKINS.length];
  const hair = HAIRS[(h >>> 3) % HAIRS.length];
  const style = HAIR_STYLES[(h >>> 7) % HAIR_STYLES.length];
  const shirt = hue.startsWith('#') ? hue : '#e0b54a';
  return (
    <svg className="of-sprite" width="40" height="50" viewBox="0 0 40 50" aria-hidden="true">
      <ellipse className="of-shadow" cx="20" cy="47.5" rx="9" ry="2.2" fill="rgba(0,0,0,.45)" />
      <g className="of-legs">
        <rect className="of-leg l" x="14.5" y="38" width="4.2" height="8" rx="2" fill="#3a3f4d" />
        <rect className="of-leg r" x="21.3" y="38" width="4.2" height="8" rx="2" fill="#3a3f4d" />
      </g>
      <g className="of-bodyg">
        <rect className="of-arm l" x="8.6" y="30.5" width="4.4" height="8.5" rx="2.2" fill={shirt} />
        <rect className="of-arm r" x="27" y="30.5" width="4.4" height="8.5" rx="2.2" fill={shirt} />
        <path d="M11.5 41 C11.5 32.5 14.5 29 20 29 C25.5 29 28.5 32.5 28.5 41 Z" fill={shirt} />
        <path d="M17 29.4 L20 32.6 L23 29.4" fill="none" stroke="rgba(255,255,255,.75)" strokeWidth="1.3" strokeLinejoin="round" />
        {ceo && <path d="M19.2 32.5 L20.8 32.5 L21.4 38 L20 39.4 L18.6 38 Z" fill="#b8323a" />}
        <circle cx="10.8" cy="39.2" r="1.9" fill={skin} />
        <circle cx="29.2" cy="39.2" r="1.9" fill={skin} />
        <g className="of-headg">
          {style.back && <path d={style.back} fill={hair} />}
          <circle cx="20" cy="18" r="13" fill={skin} />
          {sleeping ? (
            <g fill="none" stroke="#2a2018" strokeWidth="1.3" strokeLinecap="round">
              <path d="M13.8 19.5 Q15.6 21 17.4 19.5" /><path d="M22.6 19.5 Q24.4 21 26.2 19.5" />
            </g>
          ) : (
            <g className="of-eyes" fill="#2a2018">
              <ellipse cx="15.6" cy="19.2" rx="1.75" ry="2.3" /><ellipse cx="24.4" cy="19.2" rx="1.75" ry="2.3" />
              <circle cx="16.2" cy="18.3" r=".6" fill="#fff" /><circle cx="25" cy="18.3" r=".6" fill="#fff" />
            </g>
          )}
          <ellipse cx="12.6" cy="23" rx="2.3" ry="1.3" fill="#ff8fa3" opacity=".55" />
          <ellipse cx="27.4" cy="23" rx="2.3" ry="1.3" fill="#ff8fa3" opacity=".55" />
          <path className="of-mouth" d="M18.4 23.6 Q20 25.3 21.6 23.6" fill="none" stroke="#2a2018" strokeWidth="1.1" strokeLinecap="round" />
          <path d={style.front} fill={hair} />
          {style.extra?.(hair)}
          {ceo && <path d="M13.5 6.5 L15 1 L18 4.2 L20 0 L22 4.2 L25 1 L26.5 6.5 Z" fill="#f2c94c" stroke="#b8862b" strokeWidth=".7" strokeLinejoin="round" />}
        </g>
      </g>
    </svg>
  );
}

type Mode = 'work' | 'queued' | 'done' | 'failed' | 'idle';

function Walker({ agent, hue, target, mode, bubble, sleep, seated, ceo, selected, onClick }: {
  agent: OfficeAgent; hue: string; target: Pt & { key: string }; mode: Mode; bubble: string; sleep?: boolean; seated?: boolean; ceo?: boolean; selected: boolean; onClick: () => void;
}) {
  const [facing, setFacing] = useState(1);
  const [pos, setPos] = useState<Pt>(target);
  const [dur, setDur] = useState(0);
  const [walking, setWalking] = useState(false);
  const posRef = useRef<Pt>(target);
  const mountedAt = useRef(Date.now());

  useEffect(() => {
    // ตอนเพิ่งเปิดหน้า: วางทุกคนที่ตำแหน่งเลย ไม่ต้องเดิน
    if (Date.now() - mountedAt.current < 600) { posRef.current = target; setDur(0); setPos(target); return; }
    const legs = route(posRef.current, target);
    let i = 0; let t: ReturnType<typeof setTimeout>;
    const step = () => {
      if (i >= legs.length) { setWalking(false); setDur(0); return; }
      const p = legs[i++]; const from = posRef.current;
      const ms = Math.max(120, Math.hypot(p.x - from.x, p.y - from.y) * MS_PER_PX);
      if (Math.abs(p.x - from.x) > 2) setFacing(p.x < from.x ? -1 : 1);
      posRef.current = p; setDur(ms); setPos(p); setWalking(true);
      t = setTimeout(step, ms);
    };
    step();
    return () => clearTimeout(t);
  }, [target.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const cls = ['of-walker', walking ? 'walking' : '', mode === 'idle' ? (sleep ? 'idle-sleep' : 'idle') : mode, selected ? 'selected' : '', seated && !walking ? 'seated' : ''].join(' ');
  return (
    <button type="button" className={cls} onClick={onClick} aria-label={`${agent.name} · ${bubble}`}
      style={{ left: `${(pos.x / W) * 100}%`, top: `${(pos.y / H) * 100}%`, transitionDuration: `${dur}ms`, zIndex: 10 + Math.round(pos.y), '--hue': hue } as CSSProperties}>
      <span className="of-person" style={{ transform: `scaleX(${facing})` }}>
        <Chibi seed={agent.id} hue={hue} ceo={ceo} sleeping={!walking && sleep && mode === 'idle'} />
      </span>
      {!walking && sleep && mode === 'idle' && <span className="of-zz">z z</span>}
      {!walking && bubble && <span key={bubble} className={`of-bubble ${mode}`}>{bubble}</span>}
      <span className="of-name">{agent.name}</span>
    </button>
  );
}

/** ออฟฟิศมองจากด้านบน: ใครมี session ที่ queued/running จะเดินไปโต๊ะตัวเอง คนที่ว่างไปทำอย่างอื่นในห้องพัก */
export function OfficeFloor({ agents, departments, sessions, selectedSessionId, onSelect }: {
  agents: OfficeAgent[]; departments: OfficeDept[]; sessions: OfficeSession[];
  selectedSessionId?: string | null; onSelect: (sessionId: string) => void;
}) {
  const layout = useMemo(() => buildLayout(departments, agents), [departments, agents]);
  const people = useMemo(() => agents.filter((a) => layout.desks.has(a.id)), [agents, layout]);
  const agentOf = (s: OfficeSession) => people.find((a) => a.id === s.agent_id) ?? people.find((a) => a.name === s.agent_name);

  // session ล่าสุดของแต่ละคน และอันที่กำลัง active (running มาก่อน queued) — sessions เรียงใหม่สุดก่อนอยู่แล้ว
  const { activeBy, latestBy } = useMemo(() => {
    const activeBy = new Map<string, OfficeSession>(); const latestBy = new Map<string, OfficeSession>();
    for (const s of sessions) {
      const a = agentOf(s); if (!a) continue;
      if (!latestBy.has(a.id)) latestBy.set(a.id, s);
      const cur = activeBy.get(a.id);
      if (ACTIVE.includes(s.status) && (!cur || (cur.status === 'queued' && s.status === 'running'))) activeBy.set(a.id, s);
    }
    return { activeBy, latestBy };
  }, [sessions, people]); // eslint-disable-line react-hooks/exhaustive-deps

  // เพิ่งทำเสร็จ/ล้มเหลว → ค้างที่โต๊ะสักครู่พร้อมป้ายผลลัพธ์ แล้วค่อยลุก
  const [wrapUp, setWrapUp] = useState<Record<string, 'done' | 'failed'>>({});
  const prevActive = useRef<Map<string, OfficeSession>>(new Map());
  useEffect(() => {
    const ended: Record<string, 'done' | 'failed'> = {};
    prevActive.current.forEach((s, aid) => {
      if (activeBy.has(aid)) return;
      const now = sessions.find((x) => x.id === s.id);
      ended[aid] = now?.status === 'failed' ? 'failed' : 'done';
    });
    prevActive.current = new Map(activeBy);
    const ids = Object.keys(ended);
    if (!ids.length) return;
    setWrapUp((w) => ({ ...w, ...ended }));
    const t = setTimeout(() => setWrapUp((w) => { const n = { ...w }; ids.forEach((id) => delete n[id]); return n; }), 2600);
    return () => clearTimeout(t);
  }, [activeBy]); // eslint-disable-line react-hooks/exhaustive-deps

  // คนว่างจับจองจุดในห้องพัก แล้วสุ่มย้ายไปทำอย่างอื่นเรื่อยๆ
  const idleIds = people.filter((a) => !activeBy.has(a.id) && !wrapUp[a.id]).map((a) => a.id);
  const [assign, setAssign] = useState<Record<string, string>>({});
  const idleKey = idleIds.join(',');
  useEffect(() => {
    setAssign((cur) => {
      const next: Record<string, string> = {};
      const taken = new Set<string>();
      for (const id of idleIds) if (cur[id]) { next[id] = cur[id]; taken.add(cur[id]); }
      for (const id of idleIds) if (!next[id]) {
        const pool = (id === layout.ceoId ? CEO_IDLE : layout.spots).filter((s) => !taken.has(s.id));
        const pick = pool[Math.floor(Math.random() * pool.length)];
        if (pick) { next[id] = pick.id; taken.add(pick.id); }
      }
      return next;
    });
  }, [idleKey, layout]); // eslint-disable-line react-hooks/exhaustive-deps
  // ทุก 4.2 วินาที สุ่มคนว่าง 1 คน: ถ้ามีจุดว่างก็ย้ายไปจุดนั้น ถ้าห้องพักเต็ม คนที่นั่งโต๊ะสลับกับคนในห้องพัก
  // (คนในห้องพักกลับไปนั่งโต๊ะ) ทุกคนจึงได้ผลัดกันพัก ไม่ใช่ 11 คนแรกตลอด
  const idleRef = useRef<string[]>(idleIds);
  idleRef.current = idleIds;
  useEffect(() => {
    const iv = setInterval(() => setAssign((cur) => {
      const ids = idleRef.current; if (!ids.length) return cur;
      const id = ids[Math.floor(Math.random() * ids.length)];
      const taken = new Set(Object.values(cur));
      const pool = (id === layout.ceoId ? CEO_IDLE : layout.spots).filter((s) => !taken.has(s.id));
      if (pool.length) return { ...cur, [id]: pool[Math.floor(Math.random() * pool.length)].id };
      if (cur[id] || id === layout.ceoId) return cur;
      // ห้องพักเต็มและคนนี้นั่งโต๊ะอยู่: สลับที่กับคนในห้องพักแบบสุ่ม
      const inLounge = Object.keys(cur).filter((x) => x !== layout.ceoId && ids.includes(x));
      if (!inLounge.length) return cur;
      const out = inLounge[Math.floor(Math.random() * inLounge.length)];
      const next = { ...cur, [id]: cur[out] };
      delete next[out];
      return next;
    }), 4200);
    return () => clearInterval(iv);
  }, [layout]);

  const allSpots = [...layout.spots, ...CEO_IDLE];
  const selectedAgent = useMemo(() => {
    const s = sessions.find((x) => x.id === selectedSessionId);
    return s ? agentOf(s)?.id : undefined;
  }, [sessions, selectedSessionId, people]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="of-wrap">
      <div className="of-floor">
        {[60, 200, 340, 480, 720, 860].map((x) => <div key={x} className="of-window" style={{ left: `${(x / W) * 100}%`, width: `${(90 / W) * 100}%` }} />)}

        {/* ห้อง CEO */}
        <div className="of-room" style={{ left: '67.5%', top: '3%', width: '30%', height: '38%' }}><span className="of-room-label">CEO</span></div>
        {/* ห้องพัก */}
        <div className="of-room" style={{ left: '67.5%', top: '48%', width: '30%', height: '48.5%' }}><span className="of-room-label" style={{ top: -20 }}>ห้องพัก · LOUNGE</span></div>
        <div className="of-rug" style={{ left: '71%', top: '70%', width: '19%', height: '20%' }} />
        <div className="of-sofa" style={{ left: '71.5%', top: '86%', width: '17.5%', height: '7%' }} />
        <div className="of-thing" style={{ left: '71.2%', top: '56.5%', width: 30, height: 22 }} aria-hidden="true">☕</div>
        <div className="of-thing" style={{ left: '77.2%', top: '56.5%', width: 20, height: 26, background: '#2b4a63' }} aria-hidden="true" />
        <div className="of-thing" style={{ left: '92.5%', top: '56.5%', width: 52, height: 16, background: '#4a3527' }} aria-hidden="true" />
        <div className="of-thing" style={{ left: '94.5%', top: '76%', width: 30, height: 30, borderRadius: '50%', background: '#4a3d58' }} aria-hidden="true" />
        <div className="of-plant" style={{ left: '69.4%', top: '81%' }} />
        <div className="of-plant" style={{ left: '95.5%', top: '93%' }} />
        <div className="of-plant" style={{ left: '63.5%', top: '6%' }} />
        <div className="of-plant" style={{ left: '2%', top: '95%' }} />

        {/* โต๊ะทำงาน */}
        {layout.labels.map((l) => <div key={l.name + l.y} className="of-dept" style={{ left: `${(l.x / W) * 100}%`, top: `${(l.y / H) * 100}%` }}>{l.name}</div>)}
        {[...layout.desks.values()].map((d) => {
          const a = people.find((p) => p.id === d.agentId);
          const on = activeBy.get(d.agentId)?.status === 'running';
          return (
            <div key={d.agentId}>
              <div className="of-chair" style={{ left: `${(d.seat.x / W) * 100}%`, top: `${(d.seat.y / H) * 100}%` }} />
              <div className="of-desk" style={{ left: `${(d.x / W) * 100}%`, top: `${(d.tableY / H) * 100}%`, width: `${(d.w / W) * 100}%`, '--hue': d.hue } as CSSProperties}>
                <div className={`of-monitor ${on ? 'on' : ''}`} />
                <div className="of-plate">{a?.name}</div>
              </div>
            </div>
          );
        })}

        {/* คน */}
        {people.map((a) => {
          const desk = layout.desks.get(a.id)!;
          const s = activeBy.get(a.id);
          const wu = wrapUp[a.id];
          let mode: Mode, bubble: string, target: Pt & { key: string }, sleep = false;
          if (s) {
            mode = s.status === 'running' ? 'work' : 'queued';
            bubble = s.status === 'running' ? (s.task_title ?? (s.purpose === 'plan' ? 'วางแผนงาน' : s.purpose === 'assess' ? 'ให้คะแนนงาน' : 'ตอบข้อความ')) : 'รอคิว…';
            target = { ...desk.seat, key: 'desk' };
          } else if (wu) {
            mode = wu; bubble = wu === 'done' ? '✓ เสร็จแล้ว' : '✕ ล้มเหลว';
            target = { ...desk.seat, key: 'desk' };
          } else {
            const spot = allSpots.find((x) => x.id === assign[a.id]);
            mode = 'idle';
            // คนว่างโชว์แค่ไอคอน ไม่ให้รก · คลิกเลือกแล้วค่อยโชว์ว่ากำลังทำอะไร
            if (spot) { target = { ...spot, key: spot.id }; bubble = selectedAgent === a.id ? `${spot.icon} ${spot.label}`.trim() : spot.icon; sleep = !!spot.sleep; }
            else { target = { ...desk.seat, key: 'desk' }; bubble = ''; }
          }
          const sel = latestBy.get(a.id);
          return (
            <Walker key={a.id} agent={a} hue={layout.hues.get(a.id) ?? '#8b909c'} target={target} mode={mode} bubble={bubble} sleep={sleep}
              seated={target.key === 'desk' || sleep} ceo={a.id === layout.ceoId}
              selected={selectedAgent === a.id} onClick={() => { const id = s?.id ?? sel?.id; if (id) onSelect(id); }} />
          );
        })}
      </div>
    </div>
  );
}
