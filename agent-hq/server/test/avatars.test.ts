import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sniffImage, saveAvatar, findAvatar, removeAvatar, avatarVersions, avatarDir, MAX_AVATAR_BYTES } from '../src/domain/avatars.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5e2f1e80000000049454e44ae426082', 'hex');
const rakko = { id: 'ceo', name: 'Rakko' };

test('only real raster images are accepted (no SVG, no junk, size capped)', () => {
  assert.equal(sniffImage(PNG), '.png');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), '.jpg');
  assert.equal(sniffImage(Buffer.from('GIF89a......')), '.gif');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
  const dir = mkdtempSync(join(tmpdir(), 'hq-av-'));
  assert.throws(() => saveAvatar(dir, rakko, Buffer.from('<svg/>')), /PNG, JPEG/);
  assert.throws(() => saveAvatar(dir, rakko, Buffer.alloc(0)), /empty/);
  assert.throws(() => saveAvatar(dir, rakko, Buffer.concat([PNG, Buffer.alloc(MAX_AVATAR_BYTES)])), /2 MB/);
});

test('upload by id, drop-in by name, newest wins, remove clears both', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-av-'));
  assert.equal(findAvatar(dir, rakko), null);
  mkdirSync(avatarDir(dir), { recursive: true });
  const dropped = join(avatarDir(dir), 'RAKKO.png');
  writeFileSync(dropped, PNG);
  utimesSync(dropped, new Date(2020, 0, 1), new Date(2020, 0, 1));
  assert.equal(findAvatar(dir, rakko)!.path, dropped, 'matched by name, case-insensitive');

  const saved = saveAvatar(dir, rakko, PNG);
  assert.ok(saved.endsWith('ceo.png'));
  assert.ok(!existsSync(dropped), 'saving replaces older pictures of the same agent');
  assert.equal(findAvatar(dir, rakko)!.path, saved);
  assert.deepEqual(Object.keys(avatarVersions(dir, [rakko, { id: 'cto', name: 'Hachiware' }])), ['ceo']);

  removeAvatar(dir, rakko);
  assert.equal(findAvatar(dir, rakko), null);
});
