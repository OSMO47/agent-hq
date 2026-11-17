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
}

export const newId = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;

/** Run fn inside a transaction (node:sqlite has no helper). */
export function tx<T>(db: DB, fn: () => T): T {
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
