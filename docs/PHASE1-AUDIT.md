# Phase 1 — Repository Audit & Architecture Decision

Date: 2026-11-17 · Audited: `RunMaestro/Maestro` v1.0.4 (clone in `./maestro`, git-ignored, reference only)

---

## 1. Architecture report (Maestro)

| Aspect | Finding |
|---|---|
| Type | **Electron desktop app** (main process + React renderer), plus a `web-desktop` build, mobile web remote, `maestro-cli` |
| Size | ~6,000 files, ~3,100 TS/TSX source files, ~100 npm scripts |
| License | **AGPL-3.0** |
| Native deps | `node-pty`, `better-sqlite3` → `electron-rebuild` + node-gyp + Python 3 + MSVC build tools on Windows |
| Providers | 11 CLIs: Claude Code, Codex, OpenCode, Factory Droid, Copilot, Grok, Antigravity, Qwen3, Hermes, Pi, OMP |
| Claude integration | `claude --print --verbose --output-format stream-json`, `--resume`, `--permission-mode plan`, permission relay via `--permission-prompt-tool` + `--mcp-config` |
| Org model | Flat "agents" + "groups"; Group Chat = one moderator routes to agents; `@mention` consults |
| Tasks | Auto Run = markdown checklists, one fresh session per checkbox |

Main modules: `src/main/process-manager` (spawn/PTY), `agents/` (provider definitions, capabilities), `permission-relay/`, `group-chat/`, `storage/` (per-provider transcript readers), `web-server/`, `stats/`.

## 2. Existing functionality inventory
Multi-agent sessions with tabs, Git worktrees per agent, Auto Run playbooks, Group Chat moderation, cross-agent mentions, session discovery/resume, file explorer, usage dashboard, cost tracking, permission relay, retry on 529/quota, mobile remote (incl. Cloudflare tunnel), CLI, themes, achievements.

## 3. Reusable components / patterns
Reused **as design references** (re-implemented small, not copied — see §Decision):
- Claude stream-json event handling (`init` → `assistant` → `user/tool_result` → `result`).
- Permission relay idea: `--permission-prompt-tool` MCP bridge → owner approves in UI (Phase 9).
- Worktree-per-agent isolation (`worktreePaths.ts`).
- Group Chat moderator/router → basis for CEO → leader delegation.
- Retry classification for 529 / quota (`retryClassification.ts`).

## 4. Missing functionality (vs. spec)
Hierarchical organization (CEO/leaders/specialists) · departments · recruitment workflow + approval policies · project/task DB with dependencies & lifecycle · scoped memory (global/dept/project/agent/task) with protected policies · concurrency queue as a hard limit (Maestro advertises "unlimited") · org-wide audit log · owner command center.

## 5. Limitations & key risks found
1. **Electron + native modules** — install requires Python 3 + VS build tools. This machine has Python 2.7 → `npm install` of Maestro will very likely fail.
2. **Multi-provider core** — provider abstraction is threaded through ~every layer (capabilities, pickers, storage, parsers). Removing 10 providers = touching hundreds of files.
3. **`maestro-p`** drives Claude's interactive TUI "to preserve Max plan quota". That conflicts with the spec rule "do not bypass subscription restrictions" → **not used**.
4. **MCP leakage** — a plain `claude -p` loads the user's claude.ai connectors (Gmail, Drive, Calendar…) into every agent. Agents must run with `--strict-mcp-config`.
5. **Quota** — observed `rate_limit_event`: five-hour window already at 77 %. Concurrency must default low.

## Decision — build a new, small app; Maestro stays a reference
Forking Maestro would mean fighting Electron/native builds and stripping 10 providers from a 3k-file codebase, while still lacking every org/task/recruitment feature. Instead: **new `agent-hq/` app** (Express + WS + `node:sqlite` + React/Vite), zero native modules, Claude-only by construction. Maestro is not modified, so its features are "preserved" — it remains usable side-by-side. No AGPL code is copied; if code is copied later, `agent-hq` must adopt AGPL-3.0.

---

## 6. Proposed architecture

```
Browser (React/Vite/Tailwind, 127.0.0.1 only)
   │  REST + WebSocket
Express server ── Orchestrator (CEO loop, delegation, recruitment)
   │                 │
   │            TaskService (state machine, deps, locks)
   │                 │
   └── SessionManager (queue, max concurrency, timeouts, stop-all)
            │
       RuntimeAdapter (interface) ── ClaudeCliAdapter → `claude -p --output-format stream-json`
            │
   SQLite (node:sqlite, ./data/hq.db)  ·  Git worktrees (./data/workspaces/…)
```
Rules: UI never talks to processes directly; orchestration never parses CLI output (adapter emits normalized events).

## 7. Database design (SQLite)
`policies` · `departments` · `agents` · `skills` / `agent_skills` · `projects` · `tasks` · `task_dependencies` · `task_comments` · `task_attachments` · `task_history` · `sessions` · `session_events` · `messages` (agent↔agent) · `recruitment_requests` · `memories` (scope, scope_id, protected) · `approvals` · `audit_log`. Full DDL: `agent-hq/server/src/schema.sql`.

## 8. Agent lifecycle
Profile (`agents`, status active/suspended/inactive) is permanent; a **session** is created only when a task runs:
`queued → starting → running → completed | failed | stopped | timeout`.
Claude `session_id` is stored, so follow-ups / recovery use `--resume <id>`. On server restart, sessions left `running` are marked `interrupted` and their tasks return to `ASSIGNED` for retry.

## 9. Recruitment workflow
`pending_ceo → (approve|reject|clarify|reuse|modify|defer)`; if approved and policy `recruitment.requires_owner` → `pending_owner` → owner approve → profile created → `active`. Agents can only *create requests*; only the owner/policy engine changes status. Every transition is written to `audit_log`.

## 10. Security
Bind `127.0.0.1` only · `--strict-mcp-config` · per-agent `allowedTools` whitelist, `permission_mode=default` (never `bypassPermissions` by default) · `--add-dir` limited to the agent workspace · dangerous tools denied → recorded as `approvals` for owner (live relay in Phase 9) · secrets: child env scrubbed of `*_KEY/*_TOKEN/*SECRET*` · stop-all kills the process tree (`taskkill /T /F` on Windows) · protected memories cannot be written by agents.

## Roadmap (amended)
| Phase | Deliverable | Status |
|---|---|---|
| 1 | Audit + decision (this file) | ✅ |
| 2 | Schema, seed org (CEO, 6 leaders, 15 specialists as profiles), policies | ✅ in progress |
| 3 | ClaudeCliAdapter + SessionManager (queue, timeout, stop-all) | ✅ in progress |
| 4 | Task service: lifecycle, deps, locking | next |
| **MVP** | Owner request → CEO plans → 2 specialists run in worktrees → live output → Kanban → stop-all | target |
| 5–7 | Org engine, recruitment, memory/skills | after MVP |
| 8 | Full dashboard (11 pages) | incremental from MVP |
| 9–10 | Permission relay, E2E tests, Windows packaging, backup | final |

---

## Progress log

### 2026-11-17 — Phase 2 + 3 foundation
Done:
- `server/src/schema.sql` — 17 tables; `db.ts` (node:sqlite, transactions, audit, policies).
- `seed.ts` — CEO (opus) + 6 leaders + 15 specialists as **profiles**; default policies (max 2 concurrent, 20 min timeout, owner approval for recruitment); protected global memory "owner authority".
- `domain/tasks.ts` — lifecycle state machine, dependency cycle check, atomic `claimTask` lock (no duplicate execution), `readyTasks`.
- `runtime/` — `RuntimeAdapter` interface, `ClaudeCliAdapter` (`claude -p --output-format stream-json`, prompt via stdin, `--strict-mcp-config`, tool whitelist, env secret scrub, `taskkill /T /F`), `SessionManager` (queue, concurrency limit, timeout, stop, stop-all, org pause, crash recovery, every event persisted).

Verified:
- `npm test` → 13/13 pass (unit; runtime boundary uses a scripted adapter).
- `npm run test:live` → real Claude haiku session completed end-to-end.

Findings:
- Default Claude Code tool set costs ~25k input tokens per call. Loading only needed tools (`--tools`) → 3.7k (−85 %). Every profile now declares `tools`.
- `rate_limit_event` exposes real five-hour / seven-day utilization → will feed Overview "usage" (no fabrication needed).
- `total_cost_usd` is an API-equivalent estimate; on a subscription it is **not** a bill. Stored as `cost_usd_estimate`, labelled as such in UI.

Known issues / next:
- Denied tools only surface after the run (`permission_denials`); live approval relay is Phase 9.
- No HTTP/WS server or UI yet → next: Express + WS API, then MVP dashboard (Overview, Org, Tasks/Kanban, Live Sessions, stop-all).
- Worktree creation per task not yet implemented (Phase 4).
