import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { type DB, newId, audit, getPolicy, tx } from '../db.ts';
import { createTask, TaskError } from './tasks.ts';
import { buildSpec, projectWorkspace, personalityPrompt, type AgentRow } from './taskRunner.ts';
import type { SessionManager, SessionStatus } from '../runtime/sessionManager.ts';

const READ_ONLY = ['Read', 'Glob', 'Grep'];
const ENDED: SessionStatus[] = ['completed', 'failed', 'timeout', 'stopped', 'interrupted'];

export interface Meeting {
  id: string; project_id: string; topic: string; participants: string; rounds: number;
  status: 'running' | 'summarizing' | 'done' | 'stopped' | 'failed'; current_session: string | null; summary: string | null;
}
export interface MeetingPlan {
  id: string; project_id: string; topic: string; rounds: number; suggested: string; note: string | null;
  status: 'selecting' | 'proposed' | 'started' | 'cancelled' | 'failed'; session_id: string | null; meeting_id: string | null;
}
export interface Idea { title: string; description: string; assignee?: string; why?: string }

/** Pull the summary JSON out of the facilitator's reply (```json block preferred, else the outermost {...}). */
export function parseSummary(text: string): { summary: string; ideas: Idea[] } | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = fenced.length ? fenced.reverse() : [text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    try {
      const o = JSON.parse(c.trim());
      if (Array.isArray(o.ideas)) return { summary: String(o.summary ?? ''), ideas: o.ideas.filter((i: any) => typeof i?.title === 'string') };
    } catch { /* next */ }
  }
  return null;
}

/** Pull the CEO's attendee picks out of its reply: {"participants":[{"id","why"}],"note"}. */
export function parseAttendees(text: string): { picks: { id: string; why: string }[]; note: string } | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = fenced.length ? fenced.reverse() : [text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    try {
      const o = JSON.parse(c.trim());
      if (Array.isArray(o.participants)) {
        const picks = o.participants.map((p: any) => (typeof p === 'string' ? { id: p, why: '' } : { id: String(p?.id ?? ''), why: String(p?.why ?? '') })).filter((p: any) => p.id);
        return { picks, note: String(o.note ?? '') };
      }
    } catch { /* next */ }
  }
  return null;
}

/**
 * Idea meeting room. The owner sets a topic; participants speak one at a time for N rounds (each sees what was
 * said before, can read the project, cannot change anything); the CEO then distils the best ideas.
 * Ideas become tasks only when the owner approves them. Emits 'change' (meetingId).
 */
export class MeetingRoom extends EventEmitter {
  private readonly db: DB;
  private readonly sm: SessionManager;
  private readonly dataDir: string;

  constructor(db: DB, sm: SessionManager, dataDir: string) {
    super();
    this.db = db; this.sm = sm; this.dataDir = dataDir;
    sm.on('status', (sid: string, status: SessionStatus) => { if (ENDED.includes(status)) this.onEnded(sid, status); });
    db.prepare("UPDATE meeting_plans SET status = 'failed' WHERE status = 'selecting' AND (session_id IS NULL OR session_id IN (SELECT id FROM sessions WHERE status NOT IN ('queued','starting','running')))").run();
    // A restart kills live sessions: meetings that were mid-way are marked stopped (they can be continued by starting again).
    db.prepare("UPDATE meetings SET status = 'stopped', ended_at = datetime('now') WHERE status IN ('running','summarizing') AND (current_session IS NULL OR current_session IN (SELECT id FROM sessions WHERE status NOT IN ('queued','starting','running')))").run();
  }

  /** Everyone in a meeting (attendee selection, speakers, CEO summary) runs on the `models.meeting` policy (default opus, owner 2026-11-19). */
  private meetingModel() { return String(getPolicy(this.db, 'models.meeting', 'opus')); }

  private agent(id: string) { return this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined; }
  get(id: string) { return this.db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) as Meeting | undefined; }

  start(input: { projectId: string; topic: string; participants: string[]; rounds?: number; actor: string }): Meeting {
    const topic = String(input.topic ?? '').trim();
    if (!topic) throw new TaskError('topic is empty');
    if (!this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(input.projectId)) throw new TaskError('project not found');
    const people = [...new Set(input.participants ?? [])].filter((id) => this.agent(id)?.status === 'active' && id !== 'ceo');
    if (people.length < 2) throw new TaskError('invite at least 2 active team members');
    if (people.length > 6) throw new TaskError('at most 6 participants per meeting');
    const rounds = Math.min(3, Math.max(1, Number(input.rounds ?? 2) || 2));
    const id = newId('meet');
    this.db.prepare('INSERT INTO meetings (id, project_id, topic, participants, rounds) VALUES (?, ?, ?, ?, ?)')
      .run(id, input.projectId, topic, JSON.stringify(people), rounds);
    audit(this.db, input.actor, 'meeting.start', id, { participants: people, rounds });
    this.next(id);
    return this.get(id)!;
  }

  // ---------------------------------------------------------------- CEO picks attendees, owner confirms
  getPlan(id: string) { return this.db.prepare('SELECT * FROM meeting_plans WHERE id = ?').get(id) as MeetingPlan | undefined; }

  /** Step 1: the CEO reads the topic + roster and proposes who should attend. Nothing starts until the owner approves. */
  propose(input: { projectId: string; topic: string; rounds?: number; actor: string }): MeetingPlan {
    const topic = String(input.topic ?? '').trim();
    if (!topic) throw new TaskError('topic is empty');
    if (!this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(input.projectId)) throw new TaskError('project not found');
    const rounds = Math.min(3, Math.max(1, Number(input.rounds ?? 2) || 2));
    const id = newId('plan');
    this.db.prepare('INSERT INTO meeting_plans (id, project_id, topic, rounds) VALUES (?, ?, ?, ?)').run(id, input.projectId, topic, rounds);
    const ceo = this.agent('ceo')!;
    const spec = { ...buildSpec(ceo, this.selectionPrompt(topic), this.cwd({ project_id: input.projectId } as Meeting), 3, 'default'),
      model: this.meetingModel(), tools: [] as string[], allowedTools: [] as string[] };
    const sid = this.sm.enqueue({ agentId: 'ceo', actor: 'meeting', spec, purpose: 'meeting', projectId: input.projectId });
    this.db.prepare('UPDATE meeting_plans SET session_id = ? WHERE id = ?').run(sid, id);
    audit(this.db, input.actor, 'meeting.propose', id, { topic: topic.slice(0, 120) });
    this.emit('change', id);
    return this.getPlan(id)!;
  }

  /** Step 2: owner approves the list (CEO's picks as-is, or edited / extended). Starts the meeting. */
  approvePlan(planId: string, participants: string[] | undefined, rounds: number | undefined, actor: string): Meeting {
    const p = this.getPlan(planId);
    if (!p) throw new TaskError('meeting plan not found');
    if (p.status !== 'proposed') throw new TaskError(`plan is ${p.status}, not waiting for approval`);
    const list = participants ?? (JSON.parse(p.suggested) as { id: string }[]).map((x) => x.id);
    const m = this.start({ projectId: p.project_id, topic: p.topic, participants: list, rounds: rounds ?? p.rounds, actor });
    this.db.prepare("UPDATE meeting_plans SET status = 'started', meeting_id = ? WHERE id = ?").run(m.id, planId);
    this.emit('change', planId);
    return m;
  }

  cancelPlan(planId: string, actor: string) {
    const p = this.getPlan(planId);
    if (!p || !['selecting', 'proposed'].includes(p.status)) return;
    this.db.prepare("UPDATE meeting_plans SET status = 'cancelled' WHERE id = ?").run(planId);
    if (p.status === 'selecting' && p.session_id) this.sm.stop(p.session_id, actor);
    audit(this.db, actor, 'meeting.plan.cancel', planId);
    this.emit('change', planId);
  }

  private onPlanSession(p: MeetingPlan, status: SessionStatus) {
    if (p.status !== 'selecting') return;
    const text = status === 'completed' ? (this.sm.get(p.session_id!)?.result_text ?? '') : '';
    const parsed = parseAttendees(text);
    const seen = new Set<string>();
    const picks = (parsed?.picks ?? []).filter((x) => !seen.has(x.id) && seen.add(x.id) && x.id !== 'ceo' && this.agent(x.id)?.status === 'active').slice(0, 6);
    if (picks.length < 2) {
      this.db.prepare("UPDATE meeting_plans SET status = 'failed' WHERE id = ?").run(p.id);
      audit(this.db, 'system', 'meeting.plan.failed', p.id, { status });
    } else {
      this.db.prepare("UPDATE meeting_plans SET status = 'proposed', suggested = ?, note = ? WHERE id = ?").run(JSON.stringify(picks), parsed?.note ?? '', p.id);
      audit(this.db, 'ceo', 'meeting.plan.proposed', p.id, { picks: picks.map((x) => x.id) });
    }
    this.emit('change', p.id);
  }

  private selectionPrompt(topic: string) {
    const roster = (this.db.prepare("SELECT a.id, a.role, a.title, d.name dept FROM agents a LEFT JOIN departments d ON d.id = a.department_id WHERE a.status = 'active' AND a.level > 1 ORDER BY a.level, a.rowid").all() as any[])
      .map((a) => `- ${a.id}: ${a.title ?? a.role} (${a.dept ?? '-'})`).join('\n');
    return [
      '# เลือกผู้เข้าประชุมเสนอไอเดีย (คุณเป็นประธาน)',
      `## หัวข้อจากเจ้าของ\n${topic}`,
      `## ทีมที่เลือกได้ (ใช้ id)\n${roster}`,
      'เลือกเฉพาะคนที่เกี่ยวข้องกับหัวข้อนี้จริงๆ 3-6 คน (อย่างน้อย 2) ไม่ต้องเลือกครบทุกแผนก เรียงลำดับคนพูดจากคนที่ควรเริ่มก่อน',
      'เขียนเหตุผลสั้นๆ (ภาษาไทย) ว่าทำไมแต่ละคนถึงเกี่ยวข้อง แล้วตอบด้วย JSON นี้อย่างเดียวในบล็อก ```json',
      '```json\n{"participants":[{"id":"<agent id>","why":"<เหตุผลสั้นๆ>"}],"note":"<ข้อสังเกตถึงเจ้าของ ถ้ามี>"}\n```',
    ].join('\n\n');
  }

  stop(id: string, actor: string) {
    const m = this.get(id);
    if (!m || !['running', 'summarizing'].includes(m.status)) return;
    this.db.prepare("UPDATE meetings SET status = 'stopped', ended_at = datetime('now') WHERE id = ?").run(id);
    if (m.current_session) this.sm.stop(m.current_session, actor);
    audit(this.db, actor, 'meeting.stop', id);
    this.emit('change', id);
  }

  /** Owner decision on one idea. Approve → task in the meeting's project (autopilot picks it up). */
  decide(ideaId: string, approve: boolean, actor: string) {
    const idea = this.db.prepare('SELECT i.*, m.project_id, m.topic FROM meeting_ideas i JOIN meetings m ON m.id = i.meeting_id WHERE i.id = ?').get(ideaId) as any;
    if (!idea) throw new TaskError('idea not found');
    if (idea.status !== 'pending') throw new TaskError(`idea already ${idea.status}`);
    tx(this.db, () => {
      let taskId: string | null = null;
      if (approve) {
        const assignee = idea.assignee_id && this.agent(idea.assignee_id)?.status === 'active' ? idea.assignee_id : undefined;
        taskId = createTask(this.db, {
          projectId: idea.project_id, title: idea.title.slice(0, 200), actor,
          description: [idea.description, idea.why && `เหตุผล: ${idea.why}`, `(จากห้องประชุม: ${idea.topic})`].filter(Boolean).join('\n\n'),
          assigneeId: assignee,
        }).id;
      }
      this.db.prepare('UPDATE meeting_ideas SET status = ?, task_id = ? WHERE id = ?').run(approve ? 'approved' : 'rejected', taskId, ideaId);
      audit(this.db, actor, approve ? 'meeting.idea.approve' : 'meeting.idea.reject', ideaId, { taskId });
    });
    this.emit('change', idea.meeting_id);
  }

  // ---------------------------------------------------------------- turn taking
  private turns(m: Meeting) {
    const people = JSON.parse(m.participants) as string[];
    const said = (this.db.prepare('SELECT COUNT(*) n FROM meeting_messages WHERE meeting_id = ?').get(m.id) as { n: number }).n;
    return { people, said, total: people.length * m.rounds };
  }

  private cwd(m: Meeting) {
    try { return projectWorkspace(this.db, this.dataDir, m.project_id); }
    catch { const d = join(this.dataDir, 'meetings'); mkdirSync(d, { recursive: true }); return d; }
  }

  private next(id: string) {
    const m = this.get(id)!;
    if (m.status !== 'running') return;
    const { people, said, total } = this.turns(m);
    if (said >= total) return this.summarize(m);
    const speaker = this.agent(people[said % people.length])!;
    const round = Math.floor(said / people.length) + 1;
    const model = this.meetingModel();
    const spec = { ...buildSpec(speaker, this.speakerPrompt(m, speaker, round, people), this.cwd(m), 8, 'default', personalityPrompt(this.db, speaker.id)),
      model, tools: READ_ONLY, allowedTools: READ_ONLY };
    const sid = this.sm.enqueue({ agentId: speaker.id, actor: 'meeting', spec, purpose: 'meeting', projectId: m.project_id });
    this.db.prepare('UPDATE meetings SET current_session = ? WHERE id = ?').run(sid, id);
    this.emit('change', id);
  }

  private summarize(m: Meeting) {
    const ceo = this.agent('ceo')!;
    const spec = { ...buildSpec(ceo, this.summaryPrompt(m), this.cwd(m), 4, 'default'),
      model: this.meetingModel(), tools: [] as string[], allowedTools: [] as string[] };
    const sid = this.sm.enqueue({ agentId: 'ceo', actor: 'meeting', spec, purpose: 'meeting', projectId: m.project_id });
    this.db.prepare("UPDATE meetings SET status = 'summarizing', current_session = ? WHERE id = ?").run(sid, m.id);
    this.emit('change', m.id);
  }

  private onEnded(sid: string, status: SessionStatus) {
    const plan = this.db.prepare('SELECT * FROM meeting_plans WHERE session_id = ?').get(sid) as MeetingPlan | undefined;
    if (plan) return this.onPlanSession(plan, status);
    const m = this.db.prepare('SELECT * FROM meetings WHERE current_session = ?').get(sid) as Meeting | undefined;
    if (!m || !['running', 'summarizing'].includes(m.status)) return;
    const s = this.sm.get(sid)!;
    if (status === 'stopped') { // owner pressed Stop / Stop all on this session: the meeting stops, it did not fail
      this.db.prepare("UPDATE meetings SET status = 'stopped', current_session = NULL, ended_at = datetime('now') WHERE id = ?").run(m.id);
      audit(this.db, 'system', 'meeting.stop', m.id, { sessionId: sid });
      return void this.emit('change', m.id);
    }
    if (status !== 'completed' || !s.result_text?.trim()) {
      this.db.prepare("UPDATE meetings SET status = 'failed', ended_at = datetime('now') WHERE id = ?").run(m.id);
      audit(this.db, 'system', 'meeting.failed', m.id, { sessionId: sid, status });
      return void this.emit('change', m.id);
    }
    if (m.status === 'summarizing') {
      const parsed = parseSummary(s.result_text);
      const valid = new Set((this.db.prepare("SELECT id FROM agents WHERE status = 'active' AND level > 1").all() as { id: string }[]).map((r) => r.id));
      tx(this.db, () => {
        for (const i of parsed?.ideas ?? []) {
          this.db.prepare('INSERT INTO meeting_ideas (id, meeting_id, title, description, why, assignee_id) VALUES (?, ?, ?, ?, ?, ?)')
            .run(newId('idea'), m.id, i.title.slice(0, 200), String(i.description ?? ''), String(i.why ?? ''), i.assignee && valid.has(i.assignee) ? i.assignee : null);
        }
        this.db.prepare("UPDATE meetings SET status = 'done', summary = ?, current_session = NULL, ended_at = datetime('now') WHERE id = ?")
          .run(parsed?.summary || s.result_text.slice(0, 4000), m.id);
      });
      audit(this.db, 'ceo', 'meeting.done', m.id, { ideas: parsed?.ideas.length ?? 0 });
      return void this.emit('change', m.id);
    }
    const { people, said } = this.turns(m);
    this.db.prepare('INSERT INTO meeting_messages (meeting_id, agent_id, round, body, session_id) VALUES (?, ?, ?, ?, ?)')
      .run(m.id, s.agent_id, Math.floor(said / people.length) + 1, s.result_text.trim(), sid);
    this.next(m.id);
  }

  // ---------------------------------------------------------------- prompts (Thai output: the owner reads Thai)
  private transcript(m: Meeting) {
    const rows = this.db.prepare('SELECT x.*, a.name, a.role FROM meeting_messages x JOIN agents a ON a.id = x.agent_id WHERE meeting_id = ? ORDER BY x.id').all(m.id) as any[];
    return rows.length ? rows.map((r) => `### ${r.name} (${r.role}) · รอบ ${r.round}\n${r.body}`).join('\n\n') : '(ยังไม่มีใครพูด คุณเป็นคนแรก)';
  }

  private speakerPrompt(m: Meeting, me: AgentRow, round: number, people: string[]) {
    const roster = people.map((id) => { const a = this.agent(id)!; return `- ${a.name} (${a.role})`; }).join('\n');
    return [
      `# ห้องประชุมเสนอไอเดีย · รอบ ${round}/${m.rounds}`,
      `## หัวข้อจากเจ้าของ\n${m.topic}`,
      `## ผู้เข้าประชุม\n${roster}`,
      `## สิ่งที่คุยกันมาแล้ว\n${this.transcript(m)}`,
      '## ตาคุณพูด',
      `คุณคือ ${me.name} ตำแหน่ง ${me.role} ไฟล์โปรเจกต์อยู่ในโฟลเดอร์ปัจจุบัน เปิดอ่านได้ (Read/Glob/Grep) ถ้าช่วยให้ไอเดียแม่นขึ้น ห้ามแก้ไฟล์ (ถ้าโฟลเดอร์ว่าง แปลว่าเป็นโปรเจกต์ใหม่ที่ยังไม่มีโค้ด ให้เสนอจากโจทย์ได้เลย ไม่ต้องค้นหาไฟล์)`,
      round === 1
        ? '- เสนอไอเดีย 1-3 ข้อจากมุมมองตำแหน่งของคุณ แต่ละข้อต้องเป็นรูปธรรม ทำได้จริง บอกว่าได้ประโยชน์อะไร'
        : '- ต่อยอด แย้ง หรือรวมไอเดียของคนอื่น บอกชัดว่าเห็นด้วย/ไม่เห็นด้วยกับข้อไหนเพราะอะไร ห้ามพูดซ้ำสิ่งที่มีคนพูดแล้ว',
      '- ตอบเป็นภาษาไทย กระชับ ใช้ bullet ไม่เกินประมาณ 150 คำ ไม่ต้องทักทาย',
    ].join('\n\n');
  }

  private summaryPrompt(m: Meeting) {
    const roster = (this.db.prepare("SELECT id, role FROM agents WHERE status = 'active' AND level > 1 ORDER BY level, rowid").all() as any[])
      .map((a) => `- ${a.id}: ${a.role}`).join('\n');
    return [
      '# สรุปการประชุมเสนอไอเดีย (คุณเป็นประธาน)',
      `## หัวข้อจากเจ้าของ\n${m.topic}`,
      `## บันทึกการประชุม\n${this.transcript(m)}`,
      `## ทีม (ใช้ id ในช่อง assignee)\n${roster}`,
      'เลือกไอเดียที่ดีที่สุด 3-6 ข้อ รวมข้อที่ซ้ำกัน ตัดข้อที่ทำไม่ได้จริง เรียงจากคุ้มค่าที่สุด',
      'แต่ละข้อต้องเป็นงานที่ทีมลงมือทำได้: title สั้น, description บอกว่าทำอะไร แก้ตรงไหน เสร็จแล้วเป็นอย่างไร, why คือเหตุผลสั้นๆ, assignee คือ id ของคนที่เหมาะที่สุด (งานหน้าตา/UX/UI ให้ ui-ux-designer)',
      'เขียนทุกอย่างเป็นภาษาไทย แล้วตอบด้วย JSON นี้อย่างเดียวในบล็อก ```json',
      '```json\n{"summary":"<สรุปผลการประชุม 2-4 ประโยค>","ideas":[{"title":"","description":"","why":"","assignee":"<agent id>"}]}\n```',
    ].join('\n\n');
  }
}
