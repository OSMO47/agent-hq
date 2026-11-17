import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { seed } from '../src/seed.ts';
import { Deployer, shellCommand, deployEnv } from '../src/domain/deploy.ts';

test('shellCommand: project scripts are called from the project folder; UTF-8 console on Windows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-sc-'));
  writeFileSync(join(dir, 'deploy.bat'), '@echo off\n');
  assert.equal(shellCommand('deploy.bat', dir, 'win32'), 'chcp 65001>nul & .\\deploy.bat');
  assert.equal(shellCommand('deploy.bat --x', dir, 'linux'), './deploy.bat --x');
  assert.equal(shellCommand('firebase deploy', dir, 'win32'), 'chcp 65001>nul & firebase deploy', 'not a local file: unchanged');
  assert.ok(!('NoDefaultCurrentDirectoryInExePath' in deployEnv({ NoDefaultCurrentDirectoryInExePath: '1', PATH: 'x' })));
});

test('deploy runs a .bat that sits in the project folder, even with NoDefaultCurrentDirectoryInExePath set', { skip: process.platform !== 'win32' }, async () => {
  process.env.NoDefaultCurrentDirectoryInExePath = '1'; // what Claude Code sets for child processes
  const dir = mkdtempSync(join(tmpdir(), 'hq-bat-'));
  writeFileSync(join(dir, 'deploy.bat'), '@echo off\r\nchcp 65001 >nul\r\necho deploy-ทดสอบ-ok\r\npause\r\n', 'utf8');
  const db = openDb(':memory:'); seed(db);
  db.prepare('INSERT INTO projects (id, name, repo_path) VALUES (?, ?, ?)').run('p', 'P', dir);
  const d = new Deployer(db);
  const st = d.start('p', { command: 'deploy.bat', commit: false, actor: 'owner' });
  for (let i = 0; i < 200 && st.running; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(st.ok, true, st.output);
  assert.match(st.output, /deploy-ทดสอบ-ok/);
});
