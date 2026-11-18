import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/cli.js');
const skillPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../skills/fix-code');
const TOKEN = 'ghs_doctorSecret1234567890';

// Minimal valid app-mode config with a fake claude runtime and a fake gh that prints "1" for any args.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-code-doctor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const gh = path.join(bin, 'gh');
  const claude = path.join(bin, 'claude');
  // Succeeds only when the bridge injected the token file's value as GH_TOKEN, so the "installation access ok" assertion proves injection.
  fs.writeFileSync(gh, `#!${process.execPath}\nif (process.env.GH_TOKEN !== ${JSON.stringify(TOKEN)}) { console.error('not logged in'); process.exit(1); }\nconsole.log('1');\n`, { mode: 0o700 });
  fs.writeFileSync(claude, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const cloneRoot = path.join(dir, 'clones');
  fs.mkdirSync(cloneRoot, { mode: 0o700 }); fs.chmodSync(cloneRoot, 0o700);
  const tokenFile = path.join(dir, 'gh-token');
  fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o640 });
  const config = {
    teamId: 'T123', allowedUsers: ['U123'], allowedChannels: ['C123'], allowNetwork: false,
    skillPath, ghPath: gh, githubAuth: 'app', githubTokenFile: './gh-token',
    repositoryRouting: { mode: 'channel', cloneRoot },
    runtimes: { claude: { path: claude, models: { architect: 'm1', implementer: 'm1', reviewer: 'm1' }, allowedModels: ['m1'], env: [] } }
  };
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  return { dir, tokenFile, configPath };
}

function doctor(configPath) {
  const result = spawnSync(process.execPath, [cliPath, 'doctor', '--config', configPath], { encoding: 'utf8', timeout: 60000 });
  assert.equal(typeof result.stdout, 'string');
  assert.ok(!`${result.stdout}${result.stderr}`.includes(TOKEN), 'doctor output must never include the token');
  const report = JSON.parse(result.stdout);
  return { report, byName: name => report.checks.find(check => check.check === name) };
}

test('doctor rejects a two-hour-old app token file as too old', t => {
  const f = fixture(t);
  const old = new Date(Date.now() - 2 * 60 * 60000);
  fs.utimesSync(f.tokenFile, old, old);
  const { byName } = doctor(f.configPath);
  const tokenCheck = byName('GitHub token file');
  assert.ok(tokenCheck, 'GitHub token file check is reported');
  assert.equal(tokenCheck.ok, false);
  assert.match(tokenCheck.reason, /minutes old/);
});

test('doctor passes the token file and installation access checks for a fresh token', t => {
  const f = fixture(t);
  const now = new Date();
  fs.utimesSync(f.tokenFile, now, now);
  const { byName } = doctor(f.configPath);
  assert.equal(byName('GitHub token file')?.ok, true);
  assert.equal(byName('GitHub App installation access')?.ok, true);
  assert.equal(byName('GitHub CLI authentication'), undefined, 'app mode does not run gh auth status');
});
