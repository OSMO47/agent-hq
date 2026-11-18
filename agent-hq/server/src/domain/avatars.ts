import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

/**
 * Agent profile pictures, owner-supplied, kept only on this machine in <dataDir>/avatars (data/ is git-ignored).
 * A file is matched to an agent by id or by name, case-insensitive: `ceo.png`, `Rakko.webp`, `ui-ux-designer.jpg`.
 * So the owner can upload from the dashboard or simply drop image files into that folder.
 */
export const AVATAR_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

export const avatarDir = (dataDir: string) => join(dataDir, 'avatars');

/** Image kind from the file's first bytes. SVG is not accepted (it can carry script). */
export function sniffImage(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) return '.gif';
  return null;
}

/** id/name (lower-case) → file path, newest file wins when several match. */
function index(dataDir: string): Map<string, { path: string; mtime: number }> {
  const dir = avatarDir(dataDir);
  const out = new Map<string, { path: string; mtime: number }>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const ext = extname(f).toLowerCase();
    if (!AVATAR_TYPES[ext]) continue;
    const path = join(dir, f);
    const mtime = Math.floor(statSync(path).mtimeMs);
    const key = f.slice(0, -ext.length).toLowerCase();
    if ((out.get(key)?.mtime ?? -1) < mtime) out.set(key, { path, mtime });
  }
  return out;
}

export function findAvatar(dataDir: string, agent: { id: string; name: string }) {
  const idx = index(dataDir);
  const byId = idx.get(agent.id.toLowerCase());
  const byName = idx.get(agent.name.toLowerCase());
  // An uploaded file (named by id) is the owner's latest choice; a dropped file by name also works.
  return byId && byName ? (byId.mtime >= byName.mtime ? byId : byName) : byId ?? byName ?? null;
}

/** agent id → version (mtime) for cache-busting, for every agent that has a picture. */
export function avatarVersions(dataDir: string, agents: { id: string; name: string }[]): Record<string, number> {
  const idx = index(dataDir);
  const out: Record<string, number> = {};
  for (const a of agents) {
    const hit = [idx.get(a.id.toLowerCase()), idx.get(a.name.toLowerCase())].filter(Boolean).sort((x, y) => y!.mtime - x!.mtime)[0];
    if (hit) out[a.id] = hit.mtime;
  }
  return out;
}

export function saveAvatar(dataDir: string, agent: { id: string; name: string }, body: Buffer): string {
  if (!body?.length) throw new Error('empty image');
  if (body.length > MAX_AVATAR_BYTES) throw new Error('image is larger than 2 MB');
  const ext = sniffImage(body);
  if (!ext) throw new Error('use a PNG, JPEG, WebP or GIF image');
  removeAvatar(dataDir, agent);
  mkdirSync(avatarDir(dataDir), { recursive: true });
  const path = join(avatarDir(dataDir), `${agent.id}${ext}`);
  writeFileSync(path, body);
  return path;
}

/** Removes every picture matching the agent (by id or name). */
export function removeAvatar(dataDir: string, agent: { id: string; name: string }) {
  const dir = avatarDir(dataDir);
  if (!existsSync(dir)) return;
  const keys = new Set([agent.id.toLowerCase(), agent.name.toLowerCase()]);
  for (const f of readdirSync(dir)) {
    const ext = extname(f).toLowerCase();
    if (AVATAR_TYPES[ext] && keys.has(f.slice(0, -ext.length).toLowerCase())) unlinkSync(join(dir, f));
  }
}
