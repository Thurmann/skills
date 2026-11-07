import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expectedRemote, prepareTask, guardCheck, publishPR } from '../src/git.js';

const skillPath = path.resolve(import.meta.dirname, '../skills/fix-code');
const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

test('GitHub remote validation matches owner/repo and rejects other hosts or repos', () => {
  assert.equal(expectedRemote('git@github.com:Example/App.git', 'example/app'), true);
  assert.equal(expectedRemote('https://github.com/example/app.git', 'example/app'), true);
  assert.equal(expectedRemote('https://github.com/other/app.git', 'example/app'), false);
  assert.equal(expectedRemote('https://github.com.evil.invalid/example/app.git', 'example/app'), false);
  assert.equal(expectedRemote('file:///tmp/repo', 'example/app'), false);
});

test('explicit base fetch ignores custom mappings that would advance a user branch', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-code-fetch-map-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bare = path.join(root, 'remote.git'); fs.mkdirSync(bare);
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  git(source, 'init', '--initial-branch=main');
  git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(source, 'base'), 'A\n'); git(source, 'add', 'base'); git(source, 'commit', '-m', 'A');
  git(bare, 'init', '--bare'); git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(source, 'remote', 'add', 'origin', bare); git(source, 'push', 'origin', 'main');
  const checkout = path.join(root, 'checkout'); git(root, 'clone', bare, checkout);
  const branchA = git(checkout, 'rev-parse', 'main');
  git(checkout, 'checkout', '-b', 'user-work');
  git(checkout, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/heads/main');
  git(checkout, 'update-ref', 'refs/remotes/origin/main', branchA);
  fs.writeFileSync(path.join(checkout, 'user.txt'), 'keep me\n');
  const statusBefore = git(checkout, 'status', '--porcelain');
  fs.writeFileSync(path.join(source, 'base'), 'B\n'); git(source, 'commit', '-am', 'B'); git(source, 'push', 'origin', 'main');
  const branchB = git(source, 'rev-parse', 'main');
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env node\nimport {spawnSync} from 'node:child_process';\nconst args=process.argv.slice(2);if(args[0]==='remote'&&args.includes('get-url')&&args.includes('origin')){console.log('https://github.com/example/app.git');process.exit(0);}const r=spawnSync('/usr/bin/git',args,{stdio:'inherit'});process.exit(r.status??1);\n`, { mode: 0o700 });
  const originalPath = process.env.PATH; process.env.PATH = bin + path.delimiter + originalPath;
  t.after(() => { process.env.PATH = originalPath; });
  const task = { id: 'fetch-map', repository: { path: checkout, github: 'example/app', remote: 'origin', base: 'origin/main', baseBranch: 'main' } };
  const config = { skillPath, pythonPath: 'python3', stateDir: path.join(root, 'state'), worktreesRoot: path.join(root, 'workspace', 'worktrees'), allowNetwork: true };
  await prepareTask(config, task);
  assert.equal(git(checkout, 'rev-parse', 'refs/heads/main'), branchA);
  assert.equal(git(checkout, 'rev-parse', 'refs/remotes/origin/main'), branchB);
  assert.equal(git(checkout, 'status', '--porcelain'), statusBefore);
  assert.equal(git(checkout, 'branch', '--show-current'), 'user-work');
});

test('real isolated worktree and guarded publication use only explicit task ref and reuse its PR', async t => {
  assert.ok(fs.existsSync(path.join(skillPath, 'scripts/git_guard.py')), 'Installed skill is required for integration test');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-code-git-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  git(repo, 'init', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'Fixture Author'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'before\n'); git(repo, 'add', 'app.txt'); git(repo, 'commit', '-m', 'Fixture baseline');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/example/app.git');
  const mainBefore = git(repo, 'rev-parse', 'main');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'user dirty work\n');
  const statusBefore = git(repo, 'status', '--porcelain');
  const artifacts = path.join(root, 'artifacts'); fs.mkdirSync(artifacts);
  const ghState = path.join(root, 'gh-state.json');
  const ghLog = path.join(root, 'gh-log.jsonl'); const gitLog = path.join(root, 'git-pushes.jsonl');
  const ghPath = path.join(root, 'gh-fixture.mjs');
  fs.writeFileSync(ghPath, `#!/usr/bin/env node
import fs from 'node:fs';
const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(ghLog)},JSON.stringify(args)+'\\n');
if(args[0]==='pr'&&args[1]==='list') console.log(fs.existsSync(${JSON.stringify(ghState)})?fs.readFileSync(${JSON.stringify(ghState)},'utf8'):'[]');
else if(args[0]==='pr'&&args[1]==='create') { const value=k=>args[args.indexOf(k)+1]; const pr=[{number:1,url:'https://github.com/example/app/pull/1',state:'OPEN',isDraft:true,baseRefName:value('--base'),headRefName:value('--head')}];fs.writeFileSync(${JSON.stringify(ghState)},JSON.stringify(pr));console.log(pr[0].url); }
else process.exitCode=1;
`, { mode: 0o700 });
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env node
import fs from 'node:fs';import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2);
if(args[0]==='push'){fs.appendFileSync(${JSON.stringify(gitLog)},JSON.stringify(args)+'\\n');process.exit(0);}
const result=spawnSync('/usr/bin/git',args,{stdio:'inherit'});process.exit(result.status??1);
`, { mode: 0o700 });
  const originalPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + originalPath;
  t.after(() => { process.env.PATH = originalPath; });
  const config = { skillPath, pythonPath: 'python3', ghPath, stateDir: path.join(root, 'state'), worktreesRoot: path.join(root, 'workspace', 'worktrees'), allowNetwork: false };
  let task = { id: 'fixture', repository: { path: repo, github: 'example/app', remote: 'origin', base: 'main', baseBranch: 'main' }, initialRequest: 'Fix fixture bug' };
  task = await prepareTask(config, task);
  assert.notEqual(task.worktree, repo);
  assert.equal(task.worktree, path.join(config.worktreesRoot, path.basename(repo), 'fix-code-fixture'));
  fs.writeFileSync(path.join(task.worktree, 'app.txt'), 'after\n'); git(task.worktree, 'add', 'app.txt'); git(task.worktree, 'commit', '-m', 'Fixture fix');
  await guardCheck(config, task.guardState);
  assert.equal(git(repo, 'rev-parse', 'main'), mainBefore);
  assert.equal(git(repo, 'status', '--porcelain'), statusBefore);
  const reconciled = await prepareTask(config, { id: task.id, repository: task.repository });
  assert.equal(reconciled.branch, task.branch);
  config.allowNetwork = true; // Only the fixture git shim handles push; no real network.
  const first = await publishPR(config, task, 'Regression check passed.', artifacts);
  const second = await publishPR(config, task, 'Followup verified.', artifacts);
  assert.equal(first, second);
  const calls = fs.readFileSync(ghLog, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(a => a[1] === 'create').length, 1);
  assert.ok(calls.find(a => a[1] === 'create').includes('--draft'));
  const pushes = fs.readFileSync(gitLog, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(pushes.length, 2);
  assert.ok(pushes.every(args => args.length === 3 && args[0] === 'push' && args[1] === 'origin' && args[2] === `HEAD:refs/heads/${task.branch}`));
  assert.equal(git(repo, 'rev-parse', 'main'), mainBefore);
  assert.equal(git(repo, 'status', '--porcelain'), statusBefore);
  const ready = JSON.parse(fs.readFileSync(ghState, 'utf8')); ready[0].isDraft = false;
  fs.writeFileSync(ghState, JSON.stringify(ready));
  await assert.rejects(publishPR(config, task, 'Do not push ready PR.', artifacts), /no longer a draft/);
  assert.equal(fs.readFileSync(gitLog, 'utf8').trim().split('\n').length, 2);
});
