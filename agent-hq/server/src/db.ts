import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export type DB = DatabaseSync;

const here = dirname(fileURLToPath(import.meta.url));

/** Open (or create) the database and apply the idempotent schema. Use ':memory:' in tests. */
export function openDb(file: string): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  migrate(db);
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  return db;
}

/** Additive migrations for databases created by older versions (schema.sql only creates missing tables). */
function migrate(db: DB) {
  const hasTable = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  if (hasTable('tasks') && !cols('tasks').includes('difficulty')) {
    db.exec("ALTER TABLE tasks ADD COLUMN difficulty TEXT CHECK (difficulty IN ('easy','medium','hard'))");
  }
  if (hasTable('agents') && !cols('agents').includes('model_mode')) {
    db.exec("ALTER TABLE agents ADD COLUMN model_mode TEXT NOT NULL DEFAULT 'difficulty' CHECK (model_mode IN ('difficulty','fixed'))");
    // Owner rule: design work is always opus.
    db.exec("UPDATE agents SET model = 'opus', model_mode = 'fixed' WHERE id IN ('prod-dir','ui-ux-designer','ux-researcher')");
  }
  if (hasTable('sessions') && !cols('sessions').includes('purpose')) {
    db.exec("ALTER TABLE sessions ADD COLUMN purpose TEXT NOT NULL DEFAULT 'work'");
  }
  if (hasTable('projects') && !cols('projects').includes('deploy_cmd')) {
    db.exec('ALTER TABLE projects ADD COLUMN deploy_cmd TEXT');
    db.exec('ALTER TABLE projects ADD COLUMN deploy_decided_at TEXT');
  }
  if (hasTable('sessions') && !cols('sessions').includes('project_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id)');
  }
}

export const newId = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;

/** Run fn inside a transaction (node:sqlite has no helper). */
export function tx<T>(db: DB, fn: () => T): T {
  if (db.isTransaction) return fn(); // re-entrant: join the outer transaction
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function audit(db: DB, actor: string, action: string, target: string | null, details: object = {}) {
  db.prepare('INSERT INTO audit_log (actor, action, target, details) VALUES (?, ?, ?, ?)')
    .run(actor, action, target, JSON.stringify(details));
}

export function getPolicy<T>(db: DB, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM policies WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : fallback;
}

export function setPolicy(db: DB, key: string, value: unknown, actor: string) {
  db.prepare(`INSERT INTO policies (key, value, updated_by) VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by,
              updated_at = datetime('now')`).run(key, JSON.stringify(value), actor);
  audit(db, actor, 'policy.set', key, { value });
}
