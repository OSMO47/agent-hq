import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { seed } from '../src/seed.ts';
import { Deployer, shellCommand, deployEnv, gitTarget } from '../src/domain/deploy.ts';
import { spawnSync } from 'node:child_process';

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
  const st = d.start('p', { command: 'deploy.bat', commit: false, push: false, deploy: true, actor: 'owner' });
  for (let i = 0; i < 200 && st.running; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(st.ok, true, st.output);
  assert.match(st.output, /deploy-ทดสอบ-ok/);
});

const wait = async (st: { running: boolean }) => { for (let i = 0; i < 300 && st.running; i++) await new Promise((r) => setTimeout(r, 50)); };
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

test('publish: commit → push goes to the branch upstream (read from git config); failure stops before deploy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hq-push-'));
  const remote = join(root, 'remote.git'); const work = join(root, 'work');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'clone', '-q', remote, work);
  git(work, 'config', 'user.email', 'test@example.com'); git(work, 'config', 'user.name', 'test');
  writeFileSync(join(work, 'a.txt'), '1'); git(work, 'add', '-A'); git(work, 'commit', '-qm', 'init'); git(work, 'push', '-q', '-u', 'origin', 'main');

  const t0 = gitTarget(work)!;
  assert.equal(t0.branch, 'main'); assert.equal(t0.upstream, 'origin/main'); assert.equal(t0.remote, 'origin'); assert.equal(t0.ahead, 0);

  const db = openDb(':memory:'); seed(db);
  db.prepare('INSERT INTO projects (id, name, repo_path) VALUES (?, ?, ?)').run('p', 'P', work);
  db.prepare("INSERT INTO tasks (id, project_id, title, status) VALUES ('t1', 'p', 'Change a', 'DONE')").run();
  writeFileSync(join(work, 'a.txt'), '2'); // what an agent left behind
  assert.equal(gitTarget(work)!.files, 1);

  const d = new Deployer(db);
  const st = d.start('p', { commit: true, push: true, deploy: false, actor: 'owner' });
  await wait(st);
  assert.equal(st.ok, true, st.output);
  assert.match(git(remote, 'log', '-1', '--format=%B', 'main'), /Agent HQ[\s\S]*Change a/, 'commit landed on the remote');
  assert.equal(gitTarget(work)!.ahead, 0);

  // A new branch without upstream: pushed with -u to origin.
  git(work, 'checkout', '-qb', 'feature');
  writeFileSync(join(work, 'b.txt'), 'x'); git(work, 'add', '-A'); git(work, 'commit', '-qm', 'b');
  d.dismiss('p');
  const st2 = d.start('p', { commit: false, push: true, deploy: false, actor: 'owner' });
  await wait(st2);
  assert.equal(st2.ok, true, st2.output);
  assert.match(st2.output, /git push -u origin feature/);
  assert.equal(git(work, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/feature');

  // Broken remote: push fails, deploy never runs.
  git(work, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
  writeFileSync(join(work, 'c.txt'), 'x'); git(work, 'add', '-A'); git(work, 'commit', '-qm', 'c');
  d.dismiss('p');
  const st3 = d.start('p', { commit: false, push: true, deploy: true, command: 'node -e "console.log(\'DEPLOYED\')"', actor: 'owner' });
  await wait(st3);
  assert.equal(st3.ok, false);
  assert.doesNotMatch(st3.output, /DEPLOYED/);
});

test('publish refuses push with no remote, and hides credentials in remote URLs', () => {
  const root = mkdtempSync(join(tmpdir(), 'hq-noremote-'));
  git(root, 'init', '-q', '-b', 'main');
  const db = openDb(':memory:'); seed(db);
  db.prepare('INSERT INTO projects (id, name, repo_path) VALUES (?, ?, ?)').run('p', 'P', root);
  assert.throws(() => new Deployer(db).start('p', { commit: false, push: true, deploy: false, actor: 'owner' }), /no git remote/);
  git(root, 'remote', 'add', 'origin', 'https://user:secret-token@github.com/me/repo.git');
  assert.equal(gitTarget(root)!.url, 'https://github.com/me/repo.git');
});
