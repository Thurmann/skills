import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/cli.js');
const skillPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../skills/fix-code');
const TOKEN = 'github_pat_doctorSecret1234567890';

// User-mode cloud config: a fake gh that succeeds only when the bridge injected the token file's value as GH_TOKEN, and a fake claude.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-code-cloud-doctor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const gh = path.join(bin, 'gh');
  const claude = path.join(bin, 'claude');
  fs.writeFileSync(gh, `#!${process.execPath}\nif (process.env.GH_TOKEN !== ${JSON.stringify(TOKEN)}) { console.error('not logged in'); process.exit(1); }\nconsole.log('1');\n`, { mode: 0o700 });
  fs.writeFileSync(claude, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const cloneRoot = path.join(dir, 'clones');
  fs.mkdirSync(cloneRoot, { mode: 0o700 }); fs.chmodSync(cloneRoot, 0o700);
  const tokenFile = path.join(dir, 'gh-token');
  fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o640 });
  const config = {
    teamId: 'T123', allowedUsers: ['U123'], allowedChannels: ['C123'], allowNetwork: false,
    skillPath, ghPath: gh, githubTokenFile: './gh-token',
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

test('doctor accepts a two-hour-old token file in user mode and authenticates gh with the injected token', t => {
  const f = fixture(t);
  const old = new Date(Date.now() - 2 * 60 * 60000);
  fs.utimesSync(f.tokenFile, old, old);
  const { byName } = doctor(f.configPath);
  assert.equal(byName('GitHub token file')?.ok, true, 'user mode has no token age limit');
  assert.equal(byName('GitHub CLI authentication')?.ok, true, 'gh auth status sees GH_TOKEN from the token file');
  assert.equal(byName('GitHub App installation access'), undefined, 'user mode does not check App installation access');
});
