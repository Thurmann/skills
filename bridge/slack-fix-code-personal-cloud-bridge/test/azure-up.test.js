import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(pkg, 'scripts', 'azure-up.sh');
const BOT = 'xoxb-test-bot-token-123';
const APP = 'xapp-test-app-token-456';

// A fake az that answers the read-only preflight queries and records every call. git and gh are faked too,
// so the tests never reach Azure, GitHub or the network.
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-up-test-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const calls = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(bin, 'az'), `#!/bin/sh
echo "az $*" >> '${calls}'
case "$1 $2" in
  "account show") printf 'sub-1\\nMy Sub\\ntenant-1\\nme@example.com\\n' ;;
  "group exists") echo false ;;
  "vm list-skus") printf 'standardBSFamily\\t0\\t2\\n' ;;
  "vm list-usage") printf 'standardBSFamily\\t0\\t10\\n' ;;
  "keyvault list-deleted") ;;
  *) exit 3 ;;
esac
`, { mode: 0o755 });
  for (const cli of ['git', 'gh']) fs.writeFileSync(path.join(bin, cli), `#!/bin/sh\necho "${cli} $*" >> '${calls}'\nexit 0\n`, { mode: 0o755 });
  const local = path.join(dir, 'config.json');
  fs.writeFileSync(local, JSON.stringify({
    teamId: 'T0TEAM', allowedUsers: ['U0USER'], allowedChannels: ['C0CHAN'], timeoutMs: 600000, maxRepairRounds: 3,
    stateDir: '/Users/me/state', repositoryRouting: { mode: 'channel', localRoot: '~/workspace', allowedOwners: [], channelOwners: {} }
  }));
  const env = path.join(dir, '.env');
  fs.writeFileSync(env, `SLACK_BOT_TOKEN=${BOT}\nSLACK_APP_TOKEN=${APP}\nFIX_CODE_CONFIG=\n`);
  const run = (args, extraEnv = {}) => spawnSync('bash', [script, '--bridge-config', local, '--slack-env', env, ...args], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, TMPDIR: os.tmpdir(), GITHUB_OWNERS: 'octo', GIT_USER_NAME: 'Octo Cat', GIT_USER_EMAIL: '1+octo@users.noreply.github.com', ...extraEnv }
  });
  const log = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '');
  return { dir, local, run, log };
}

test('azure-up.sh passes bash -n and is executable', () => {
  assert.equal(spawnSync('bash', ['-n', script]).status, 0);
  assert.ok(fs.statSync(script).mode & 0o100);
});

test('--print-config reuses the local Slack settings and keeps the cloud layout', () => {
  const s = sandbox();
  const r = s.run(['--print-config']);
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(r.stdout);
  assert.equal(cfg.teamId, 'T0TEAM');
  assert.deepEqual(cfg.allowedUsers, ['U0USER']);
  assert.deepEqual(cfg.allowedChannels, ['C0CHAN']);
  assert.equal(cfg.timeoutMs, 600000);
  assert.equal(cfg.maxRepairRounds, 3);
  assert.equal(cfg.stateDir, '/var/lib/slack-fix-code-personal-cloud-bridge');
  assert.equal(cfg.githubTokenFile, '/run/fix-code-secrets/slack-fix-code-personal-cloud-bridge/gh-token');
  assert.deepEqual(cfg.repositoryRouting.allowedOwners, ['octo']);
  assert.equal(cfg.repositoryRouting.localRoot, undefined);
  assert.ok(!/xox|xapp/.test(r.stdout + r.stderr));
  assert.equal(s.log(), '', 'print-config must not call az, gh or git');
});

test('--print-config fails on an invalid local config', () => {
  const s = sandbox();
  fs.writeFileSync(s.local, JSON.stringify({ allowedUsers: ['U0USER'], allowedChannels: ['C0CHAN'] }));
  const r = s.run(['--print-config']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /teamId/);
});

test('secrets in the settings file are rejected', () => {
  const s = sandbox();
  const conf = path.join(s.dir, 'azure.env');
  fs.writeFileSync(conf, 'GITHUB_PAT=github_pat_x\n');
  const r = s.run(['--config', conf, '--print-config']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /GITHUB_PAT is a secret/);
});

test('--dry-run only reads from Azure and never prints the tokens', () => {
  const s = sandbox();
  const r = s.run(['--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WHAT THIS WILL CREATE/);
  assert.match(r.stderr, /team T0TEAM, channels C0CHAN/);
  assert.match(r.stderr, /Key Vault kv-fixcode-[0-9a-f]{6}/);
  assert.match(r.stderr, /Dry run: nothing was changed/);
  assert.ok(!(r.stdout + r.stderr).includes(BOT) && !(r.stdout + r.stderr).includes(APP));
  const calls = s.log();
  assert.match(calls, /az account show/);
  assert.ok(!/ create | set | invoke |assignment create/.test(calls), calls);
  assert.ok(!calls.includes(BOT) && !calls.includes(APP));
});

test('a Slack .env without a bot token fails before any Azure call', () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.dir, '.env'), `SLACK_APP_TOKEN=${APP}\n`);
  const r = s.run(['--dry-run']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /SLACK_BOT_TOKEN/);
  assert.ok(!s.log().includes('az '));
});
