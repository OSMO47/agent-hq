# Agent HQ

A local dashboard that runs a small **AI organization made of Claude Code sessions**: a CEO, six department leaders and specialists. You describe the work; the CEO plans it, assigns people, and the team runs it on your machine. You are only asked when someone needs a decision, and when the work is finished (to deploy or not).

- **Three-pane dashboard**: organization on the left, each agent's live conversation in the middle, Inbox / Tasks / Activity / History on the right. Themes, monospace, keyboard shortcuts.
- **Autopilot**: the CEO assigns tasks, the department leader rates difficulty (easy → haiku, medium → sonnet, hard → opus, editable), ready work starts by itself, dependent tasks follow, and routine results are approved automatically.
- **Inbox**: only what needs you, such as an agent's question (`NEEDS_OWNER`), a failed task, or "work finished: deploy?".
- **Safe by default**: agents work on local files only. `git push`, deploy scripts, `firebase`, `rm`, `curl` are hard-blocked. Only your Deploy button publishes. The server listens on `127.0.0.1` only.
- **Live view**: team terminals on the Overview, Claude 5-hour usage meter, stop-all and pause always visible.

## Requirements

| | |
|---|---|
| Node.js | **24 or newer** (uses built-in `node:sqlite` and runs TypeScript directly; no build step for the server) |
| Claude Code CLI | installed and logged in: run `claude` once in a terminal |
| OS | Windows 10/11 (tested). macOS / Linux should work with `npm start` |

Agents run on your Claude subscription through the official CLI (`claude -p`). Each task uses your normal plan quota.

## Run it

```powershell
git clone https://github.com/OSMO47/agent-hq.git
cd agent-hq/agent-hq
npm install
npm run build        # builds the dashboard once
npm start            # http://127.0.0.1:4317
```

On Windows you can use the launcher instead (checks Node and Claude, installs, builds, opens the browser):

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

Stop with **Ctrl+C**. That also stops every running agent session.

### First use

1. **Task board → New project**: give it a name and the **folder of the project** you want the team to work on (for example your website repo). Agents can only work inside this folder. Commit your own changes first so agent edits are easy to review.
2. **✦ Brief CEO** (bottom left): describe what you want in plain words. The CEO reads the project (read-only) and creates tasks with owners and dependencies. Or use **＋ New Task** for a single job and leave *Assignee* on **Auto**.
3. Watch it work: **Overview → Team terminals**, or click an agent on the left to see its conversation.
4. Answer what shows up in the **Inbox** (right bar, first tab). When all tasks of a project are done you get a notification and the choice to **🚀 Deploy** (runs the project's deploy command, for example `deploy.bat` or `npm run deploy`, optionally committing first) or skip.

The organization starts **unpaused with Autopilot on**. Change this anytime: ☰ menu → Pause / Autopilot, or **Settings**.

### Settings worth knowing

| Setting | Default | What it does |
|---|---|---|
| Autopilot | on | CEO assigns, work starts and routine results are approved automatically |
| Permission mode | `auto` | Claude Code approves safe actions itself; `default` = only the allow-listed commands. Blocked commands stay blocked in both |
| Model by difficulty | haiku / sonnet / opus | Which model runs easy / medium / hard tasks. Design agents are always opus |
| Concurrent sessions | 2 | Claude processes at once |
| Session timeout / max turns | 20 min / 30 | Limits per run |

On a Claude usage limit the queue waits for the reset and resumes the same conversation. It never switches to a weaker model by itself.

## Environment variables

| Variable | Default | |
|---|---|---|
| `HQ_PORT` | `4317` | Dashboard / API port (always bound to 127.0.0.1) |
| `HQ_DATA_DIR` | `agent-hq/data` | SQLite database and default workspaces |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code CLI |
| `HQ_NO_USAGE_PROBE` | | `1` = do not fetch Claude usage at startup (one tiny haiku call) |

## Development

```powershell
cd agent-hq
npm test                                   # unit + API tests, no Claude usage
npm run test:live                          # one real haiku call (uses quota)
powershell -File .\start.ps1 -Dev          # API with --watch + Vite dev server on http://127.0.0.1:5173
```

```
agent-hq/
  server/src/
    app.ts              REST + WebSocket API, owner Inbox, deploy routes
    db.ts, schema.sql   SQLite (node:sqlite) schema and migrations
    seed.ts             default organization and policies
    domain/             tasks, task runner (autopilot, difficulty, escalation), CEO planner, deploy, projects
    runtime/            Claude Code CLI adapter, session manager (queue, limits, stop-all)
  server/test/          node:test suites
  web/src/              React dashboard (Vite + Tailwind)
docs/PHASE1-AUDIT.md    design notes and progress log
```

---

## ภาษาไทย: วิธีเปิดใช้งาน

1. ติดตั้ง **Node.js 24 ขึ้นไป** และ **Claude Code** แล้วพิมพ์ `claude` ในเทอร์มินัลหนึ่งครั้งเพื่อ login
2. เปิด PowerShell ในโฟลเดอร์ `agent-hq` (โฟลเดอร์ย่อย) แล้วรัน
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\start.ps1
   ```
   เบราว์เซอร์จะเปิด http://127.0.0.1:4317 ให้เอง ถ้าจะปิด กด **Ctrl+C**
3. ไปที่ Task board แล้วกด **New project** ใส่โฟลเดอร์ของโปรเจกต์ที่จะให้ทีมทำ
4. กด **✦ Brief CEO** แล้วพิมพ์สิ่งที่อยากได้ ทีมจะแบ่งงานและเริ่มทำเอง (Autopilot)
5. คอยดูแท็บ **อนุมัติ** ทางขวา ระบบจะถามคุณเฉพาะเรื่องที่ต้องตัดสินใจ และถามว่าจะ **Deploy** ไหมเมื่องานเสร็จ

agent ทำงานกับไฟล์ในเครื่องเท่านั้น จะ deploy หรือ push ไม่ได้ การ deploy เกิดขึ้นเฉพาะตอนที่คุณกดปุ่ม 🚀 Deploy
