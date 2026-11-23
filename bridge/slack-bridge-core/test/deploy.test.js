import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const deploy = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'deploy');
const variant = 'slack-fix-code-personal-cloud-bridge';
const sh = (script, args, env = {}) => spawnSync('bash', [path.join(deploy, script), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: os.tmpdir(), ...env } });
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);

test('every deploy shell script passes bash -n', () => {
  const scripts = walk(deploy).filter(f => f.endsWith('.sh'));
  assert.ok(scripts.length >= 2);
  for (const f of scripts) assert.equal(spawnSync('bash', ['-n', f]).status, 0, f);
});

test('provision.sh --dry-run prints the az commands without secrets', () => {
  const r = sh('azure/provision.sh', ['--dry-run', '--variant', variant, '--foundry-resource', 'f1']);
  assert.equal(r.status, 0, r.stderr);
  for (const s of ['az keyvault create', 'az vm create', '--assign-identity', 'Key Vault Secrets User', 'Cognitive Services User', '--nsg-rule NONE']) assert.ok(r.stdout.includes(s), s);
  assert.ok(!r.stdout.includes('xox'));
});

test('provision.sh rejects invalid variants', () => {
  for (const v of ['../etc', 'Bad_Name', 'a b']) assert.notEqual(sh('azure/provision.sh', ['--dry-run', '--variant', v]).status, 0, v);
  assert.notEqual(sh('azure/provision.sh', ['--dry-run']).status, 0);
});

test('fetch-secrets.sh dry-runs and validates input', () => {
  const none = sh('bin/fetch-secrets.sh', [variant, '--provider', 'none', '--dry-run']);
  assert.equal(none.status, 0, none.stderr);
  assert.notEqual(sh('bin/fetch-secrets.sh', ['../etc', '--dry-run']).status, 0);
  assert.notEqual(sh('bin/fetch-secrets.sh', [variant, '--provider', 'bogus', '--dry-run']).status, 0);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-'));
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-run-'));
  try {
    fs.mkdirSync(path.join(root, variant));
    fs.writeFileSync(path.join(root, variant, 'deploy.env'), 'AZURE_KEY_VAULT=kv-test\n');
    const r = sh('bin/fetch-secrets.sh', [variant, '--provider', 'azure', '--dry-run'], { FIX_CODE_DEPLOY_ETC: root, FIX_CODE_DEPLOY_RUN: run });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('az keyvault secret show --vault-name kv-test --name slack-bot-token'));
    assert.deepEqual(fs.readdirSync(run), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(run, { recursive: true, force: true });
  }
});

test('systemd unit matches the variant layout', () => {
  const unit = fs.readFileSync(path.join(deploy, 'systemd', 'fix-code-bridge@.service'), 'utf8');
  for (const s of ['ExecStart=/usr/bin/node src/cli.js start --config /etc/%i/config.json', 'WorkingDirectory=/opt/fix-code/bridge/%i', 'ExecStartPre=+/opt/fix-code/bridge/slack-bridge-core/deploy/bin/fetch-secrets.sh %i', 'EnvironmentFile=-/run/%i/secrets.env', 'StateDirectory=%i', 'RuntimeDirectory=%i', 'NoNewPrivileges=true']) assert.ok(unit.includes(s), s);
  assert.ok(fs.existsSync(path.join(deploy, 'bin', 'fetch-secrets.sh')));
});

test('cloud-init starts with #cloud-config and parses when PyYAML exists', t => {
  const file = path.join(deploy, 'cloud-init', 'fix-code-bridge.yaml');
  assert.ok(fs.readFileSync(file, 'utf8').startsWith('#cloud-config'));
  const r = spawnSync('python3', ['-c', 'import sys,yaml;yaml.safe_load(open(sys.argv[1]))', file], { encoding: 'utf8' });
  if (r.status !== 0 && /No module named/.test(r.stderr)) return t.skip('PyYAML not installed');
  assert.equal(r.status, 0, r.stderr);
});
