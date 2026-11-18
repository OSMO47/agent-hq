import type { ReactNode } from 'react';
import { useResource } from '../api';
import { Empty } from '../ui';
import { Avatar } from '../Avatar';

type Agent = { id: string; name: string; role: string; title: string | null; level: number; department_id: string | null; status: string;
  avatar: number | null; session_status: string | null; current_task: string | null };
type Dept = { id: string; name: string; leader_id: string | null };

/** Tier colours: GM / Leader group / members (token based, so every theme works). */
export const TIER = {
  1: { label: 'GM', bar: 'bg-accent', text: 'text-accent' },
  2: { label: 'Leader', bar: 'bg-ai', text: 'text-ai' },
  3: { label: 'Member', bar: 'bg-matcha', text: 'text-matcha' },
} as Record<number, { label: string; bar: string; text: string }>;

/** Free desks kept on every island, and empty islands kept for departments that do not exist yet. */
const SPARE_PER_ISLAND = 2;
const FUTURE_ISLANDS = 2;
const FUTURE_DESKS = 6;

const LIVE = ['queued', 'starting', 'running'];
const working = (a: Agent) => !!a.session_status && LIVE.includes(a.session_status);
const prefix = (d: Dept) => d.id.slice(0, 1).toUpperCase();

/**
 * Office floor plan, after the usual Japanese 座席表: each department is an island of facing desks with its
 * leader at the head, shared rooms along the top wall, spare desks on every island and empty islands for new departments.
 */
export default function Seats() {
  const { data } = useResource<{ departments: Dept[]; agents: Agent[] }>('/api/org', ['org', 'session.status']);
  if (!data) return <Empty>Loading…</Empty>;
  const gm = data.agents.find((a) => a.level === 1);
  const busy = data.agents.filter(working).length;

  return (
    <div className="min-h-full bg-ink p-5">
      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="label">ผังที่นั่ง · OSMO AGENT office</span>
        <span className="text-[11px] text-faint">{data.agents.length} คน · {busy} กำลังทำงาน</span>
        <div className="ml-auto flex items-center gap-4 text-[11px] text-dim">
          {[1, 2, 3].map((l) => <span key={l} className="flex items-center gap-1.5"><span className={`h-2 w-4 rounded-full ${TIER[l].bar}`} />{TIER[l].label}</span>)}
          <span className="flex items-center gap-1.5"><span className="h-2 w-4 rounded-full border border-dashed border-line-strong" />ว่าง</span>
        </div>
      </div>

      {/* the floor */}
      <div className="rounded-lg border border-line-strong bg-panel p-4 shadow-[0_1px_2px_rgb(0_0_0/0.08)]"
        style={{ backgroundImage: 'radial-gradient(color-mix(in srgb, var(--color-line-strong) 55%, transparent) 1px, transparent 1px)', backgroundSize: '18px 18px' }}>
        {/* shared rooms along the top wall */}
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Room title="ห้อง GM" sub="General Manager" tone="border-accent/40">
            {gm ? <Desk a={gm} code="GM" /> : <EmptyDesk code="GM" />}
          </Room>
          <Room title="ห้องประชุม" sub="Meeting room" href="#/meetings">
            <div className="flex h-full items-center justify-center text-[11.5px] text-dim">เปิดห้องประชุม →</div>
          </Room>
          <Room title="Claude server" sub="ห้อง CPU">
            <div className="flex h-full flex-col items-center justify-center gap-1">
              <span className={`font-mono text-[22px] leading-none ${busy ? 'text-matcha' : 'text-faint'}`}>{busy}</span>
              <span className="text-[10.5px] text-faint">sessions running</span>
            </div>
          </Room>
          <Room title="ห้องพัก" sub="Break room">
            <div className="flex h-full flex-wrap content-center items-center justify-center gap-1.5">
              {data.agents.filter((a) => a.status !== 'active').map((a) => <Avatar key={a.id} agent={a} size={22} />)}
              {data.agents.every((a) => a.status === 'active') && <span className="text-[11px] text-faint">ไม่มีใครพัก</span>}
            </div>
          </Room>
        </div>

        {/* desk islands, one per department, plus empty ones for departments to come */}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
          {data.departments.map((d) => (
            <Island key={d.id} dept={d}
              leader={data.agents.find((a) => a.id === d.leader_id) ?? null}
              members={data.agents.filter((a) => a.department_id === d.id && a.level === 3)} />
          ))}
          {Array.from({ length: FUTURE_ISLANDS }, (_, i) => <FutureIsland key={i} n={i + 1} />)}
        </div>
      </div>
    </div>
  );
}

function Room({ title, sub, tone = 'border-line-strong', href, children }: { title: string; sub: string; tone?: string; href?: string; children: ReactNode }) {
  const body = (
    <>
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-[12px] font-bold">{title}</span>
        <span className="truncate text-[10.5px] text-faint">{sub}</span>
      </div>
      <div className="min-h-[86px] flex-1">{children}</div>
    </>
  );
  const cls = `flex flex-col rounded-lg border bg-ink/60 p-3 ${tone}`;
  return href ? <a href={href} className={`${cls} transition-colors hover:bg-raise/60`}>{body}</a> : <div className={cls}>{body}</div>;
}

/** Two facing rows of desks around a shared table, leader at the head. */
function Island({ dept, leader, members }: { dept: Dept; leader: Agent | null; members: Agent[] }) {
  const perSide = Math.max(2, Math.ceil((members.length + SPARE_PER_ISLAND) / 2));
  const seats: (Agent | null)[] = [...members, ...Array(perSide * 2 - members.length).fill(null)];
  const top = seats.slice(0, perSide);
  const bottom = seats.slice(perSide);
  const code = (i: number) => `${prefix(dept)}-${String(i + 1).padStart(2, '0')}`;
  const free = seats.filter((s) => !s).length;

  return (
    <section className="flex flex-col items-center rounded-lg border border-line bg-ink/40 p-3">
      <div className="mb-2">{leader ? <Desk a={leader} code={`${prefix(dept)}-L`} head /> : <EmptyDesk code={`${prefix(dept)}-L`} head />}</div>
      <div className="grid w-full gap-1.5" style={{ gridTemplateColumns: `repeat(${perSide}, minmax(0, 1fr))` }}>
        {top.map((a, i) => (a ? <Desk key={a.id} a={a} code={code(i)} /> : <EmptyDesk key={i} code={code(i)} />))}
        {/* the shared table between the two rows */}
        <div className="h-2.5 rounded-full bg-line-strong/60" style={{ gridColumn: `1 / span ${perSide}` }} aria-hidden />
        {bottom.map((a, i) => (a ? <Desk key={a.id} a={a} code={code(perSide + i)} /> : <EmptyDesk key={i} code={code(perSide + i)} />))}
      </div>
      <div className="mt-3 flex w-full items-center justify-between border-t border-line pt-2">
        <span className="text-[12px] font-bold">{dept.name}</span>
        <span className="text-[10.5px] text-faint">{members.length + (leader ? 1 : 0)} คน · ว่าง {free}</span>
      </div>
    </section>
  );
}

function FutureIsland({ n }: { n: number }) {
  const perSide = FUTURE_DESKS / 2;
  return (
    <section className="flex flex-col items-center rounded-lg border border-dashed border-line-strong p-3 opacity-80">
      <div className="mb-2"><EmptyDesk code={`N${n}-L`} head /></div>
      <div className="grid w-full gap-1.5" style={{ gridTemplateColumns: `repeat(${perSide}, minmax(0, 1fr))` }}>
        {Array.from({ length: perSide }, (_, i) => <EmptyDesk key={`t${i}`} code={`N${n}-${String(i + 1).padStart(2, '0')}`} />)}
        <div className="h-2.5 rounded-full bg-line/70" style={{ gridColumn: `1 / span ${perSide}` }} aria-hidden />
        {Array.from({ length: perSide }, (_, i) => <EmptyDesk key={`b${i}`} code={`N${n}-${String(perSide + i + 1).padStart(2, '0')}`} />)}
      </div>
      <div className="mt-3 flex w-full items-center justify-between border-t border-dashed border-line pt-2">
        <span className="text-[12px] font-bold text-dim">แผนกใหม่ {n}</span>
        <span className="text-[10.5px] text-faint">เผื่อไว้ · ว่าง {FUTURE_DESKS + 1}</span>
      </div>
    </section>
  );
}

function Desk({ a, code, head }: { a: Agent; code: string; head?: boolean }) {
  const tier = TIER[a.level] ?? TIER[3];
  const live = working(a);
  const off = a.status !== 'active';
  return (
    <a href={`#/agent/${a.id}`} title={`${a.name} · ${a.title ?? a.role}${a.current_task ? `\n→ ${a.current_task}` : ''}`}
      className={`relative flex min-w-0 flex-col items-center overflow-hidden rounded-lg border bg-panel px-1.5 pb-1.5 pt-2.5 text-center transition-[border-color,box-shadow] duration-300 hover:border-line-strong
        ${head ? 'w-[132px]' : ''}
        ${live ? 'border-matcha/60 shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-matcha)_18%,transparent),0_4px_16px_-4px_color-mix(in_srgb,var(--color-matcha)_40%,transparent)]' : 'border-line'}
        ${off ? 'opacity-50' : ''}`}>
      <span className={`absolute inset-x-0 top-0 h-1 ${tier.bar}`} aria-hidden />
      <Avatar agent={a} size={head ? 36 : 30} />
      <span className="mt-1 w-full truncate text-[11.5px] font-bold">{a.name}</span>
      <span className="w-full truncate text-[9.5px] text-dim">{a.title ?? a.role}</span>
      <span className="mt-1 flex items-center gap-1 font-mono text-[9px] text-faint">
        {live && <span className="breathe size-1.5 rounded-full bg-matcha" />}
        <span className={tier.text}>{tier.label}</span>·{code}
      </span>
    </a>
  );
}

function EmptyDesk({ code, head }: { code: string; head?: boolean }) {
  return (
    <div title="ที่นั่งว่าง (เผื่อรับคนเพิ่ม)"
      className={`flex min-h-[92px] min-w-0 flex-col items-center justify-center rounded-lg border border-dashed border-line-strong/80 text-center ${head ? 'w-[132px]' : ''}`}>
      <span className="text-[11px] text-faint">ว่าง</span>
      <span className="font-mono text-[9px] text-faint/80">{code}</span>
    </div>
  );
}
