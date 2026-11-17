PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- Small internal state that must survive restarts (not owner policy), e.g. last Claude usage report.
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,              -- JSON
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS policies (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,              -- JSON
  updated_by TEXT NOT NULL DEFAULT 'system',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS departments (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  leader_id   TEXT,                       -- agents.id (no FK: circular)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL,
  level         INTEGER NOT NULL CHECK (level BETWEEN 1 AND 3), -- 1 CEO, 2 leader, 3 specialist
  department_id TEXT REFERENCES departments(id),
  reports_to    TEXT REFERENCES agents(id),
  model         TEXT NOT NULL,            -- alias passed to --model (opus|sonnet|haiku|full id)
  model_mode    TEXT NOT NULL DEFAULT 'difficulty' CHECK (model_mode IN ('difficulty','fixed')), -- fixed = always `model`
  instructions  TEXT NOT NULL DEFAULT '',
  permissions   TEXT NOT NULL DEFAULT '{}', -- JSON {allowedTools[], disallowedTools[], permissionMode}
  workspace     TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','inactive')),
  created_by    TEXT NOT NULL DEFAULT 'system',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS skills (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  description  TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS agent_skills (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, skill_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  repo_path   TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id     TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'BACKLOG' CHECK (status IN
                ('BACKLOG','PLANNED','ASSIGNED','RUNNING','REVIEW','DONE','BLOCKED','FAILED','CANCELLED')),
  priority      INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 4), -- 0 = highest
  difficulty    TEXT CHECK (difficulty IN ('easy','medium','hard')), -- picks the model; NULL = agent's model
  deadline      TEXT,
  assignee_id   TEXT REFERENCES agents(id),
  department_id TEXT REFERENCES departments(id),
  review_status TEXT CHECK (review_status IN ('pending','approved','changes_requested')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  lock_session  TEXT,                     -- non-null while a session owns it (prevents duplicate execution)
  created_by    TEXT NOT NULL DEFAULT 'owner',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on),
  CHECK (task_id <> depends_on)
);

CREATE TABLE IF NOT EXISTS task_comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author     TEXT NOT NULL,              -- 'owner' or agent id
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_attachments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor       TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  agent_id          TEXT NOT NULL REFERENCES agents(id),
  task_id           TEXT REFERENCES tasks(id),
  purpose           TEXT NOT NULL DEFAULT 'work', -- work | assess | plan | message
  project_id        TEXT REFERENCES projects(id),
  claude_session_id TEXT,
  status            TEXT NOT NULL CHECK (status IN
                    ('queued','starting','running','completed','failed','stopped','timeout','interrupted')),
  model             TEXT,
  pid               INTEGER,
  prompt            TEXT NOT NULL,
  spec              TEXT NOT NULL,       -- JSON RunSpec, so queued sessions survive restarts
  result_text       TEXT,
  error             TEXT,
  cost_usd_estimate REAL,                -- as reported by CLI; API-equivalent estimate, not a bill
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  num_turns         INTEGER,
  queued_at         TEXT NOT NULL DEFAULT (datetime('now')),
  started_at        TEXT,
  ended_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

CREATE TABLE IF NOT EXISTS session_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  data       TEXT NOT NULL,              -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id, id);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id    TEXT NOT NULL,              -- 'owner' or agent id
  to_id      TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('delegation','report','review','question','answer','chat')),
  project_id TEXT REFERENCES projects(id),
  task_id    TEXT REFERENCES tasks(id),
  body       TEXT NOT NULL,
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recruitment_requests (
  id               TEXT PRIMARY KEY,
  requested_by     TEXT NOT NULL REFERENCES agents(id),
  role             TEXT NOT NULL,
  department_id    TEXT REFERENCES departments(id),
  justification    TEXT NOT NULL,
  skills           TEXT NOT NULL DEFAULT '[]',
  responsibilities TEXT NOT NULL DEFAULT '',
  model            TEXT NOT NULL DEFAULT 'opus',
  workload         TEXT NOT NULL DEFAULT '',
  estimated_usage  TEXT NOT NULL DEFAULT '',
  benefits         TEXT NOT NULL DEFAULT '',
  project_id       TEXT REFERENCES projects(id),
  priority         INTEGER NOT NULL DEFAULT 2,
  status           TEXT NOT NULL DEFAULT 'pending_ceo' CHECK (status IN
                   ('pending_ceo','pending_owner','approved','rejected','clarification','deferred','reused')),
  ceo_recommendation TEXT,
  owner_note       TEXT,
  created_agent_id TEXT REFERENCES agents(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at       TEXT
);

CREATE TABLE IF NOT EXISTS memories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL CHECK (scope IN ('global','department','project','agent','task')),
  scope_id   TEXT NOT NULL DEFAULT '',
  key        TEXT NOT NULL,
  content    TEXT NOT NULL,
  protected  INTEGER NOT NULL DEFAULT 0, -- 1 = only owner may change
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (scope, scope_id, key)
);

CREATE TABLE IF NOT EXISTS approvals (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,            -- 'tool' | 'recruitment' | 'org_change'
  payload      TEXT NOT NULL,            -- JSON
  requested_by TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at   TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  details    TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
