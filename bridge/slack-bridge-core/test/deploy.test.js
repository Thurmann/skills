import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const deploy = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'deploy');
const variant = 'slack-fix-code-personal-cloud-bridge';
// Tripwire: dry runs must never reach a real cloud CLI. These fakes shadow az/aws/gcloud on PATH and record any call.
const tripwire = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-tripwire-'));
const tripwireLog = path.join(tripwire, 'calls.log');
for (const cli of ['az', 'aws', 'gcloud']) fs.writeFileSync(path.join(tripwire, cli), `#!/bin/sh\necho "${cli} $*" >> '${tripwireLog}'\nexit 99\n`, { mode: 0o755 });
const assertNoCloudCalls = () => assert.ok(!fs.existsSync(tripwireLog), `dry run invoked a cloud CLI: ${fs.existsSync(tripwireLog) ? fs.readFileSync(tripwireLog, 'utf8') : ''}`);
const sh = (script, args, env = {}) => {
  const r = spawnSync('bash', [path.join(deploy, script), ...args], { encoding: 'utf8', env: { PATH: `${tripwire}:${process.env.PATH}`, HOME: process.env.HOME, TMPDIR: os.tmpdir(), ...env } });
  if (args.includes('--dry-run')) assertNoCloudCalls();
  return r;
};
const foundryId = '/subscriptions/abc-1/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/f1';
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);

test('every deploy shell script passes bash -n', () => {
  const scripts = walk(deploy).filter(f => f.endsWith('.sh'));
  assert.ok(scripts.length >= 2);
  for (const f of scripts) assert.equal(spawnSync('bash', ['-n', f]).status, 0, f);
});

test('provision.sh --dry-run prints the az commands without secrets', () => {
  const r = sh('azure/provision.sh', ['--dry-run', '--variant', variant, '--foundry-resource-id', foundryId]);
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

// --- fetch-secrets.sh with fake cloud CLIs ---
function fixture(t, { provider = 'azure', deployEnv = '', fakes = {} } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-fx-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const etc = path.join(base, 'etc'); const run = path.join(base, 'run'); const bin = path.join(base, 'bin'); const home = path.join(base, 'planted-home'); const log = path.join(base, 'calls.log');
  for (const d of [path.join(etc, variant), run, bin, path.join(home, '.aws')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, '.aws', 'config'), '[default]\ncredential_process = touch ' + path.join(base, 'PWNED') + '\n');
  const defaults = {
    'slack-bot-token': 'xoxb-1', 'slack-app-token': 'xapp-1', 'github-pat': 'ghp_1', 'anthropic-api-key': 'sk-1',
  };
  const values = { ...defaults, ...(fakes.values || {}) };
  const errors = fakes.errors || {}; // name -> stderr text (exit 1)
  const script = `#!/usr/bin/env bash
cli="$(basename "$0")"
echo "$cli HOME=$HOME AWS_CONFIG_FILE=\${AWS_CONFIG_FILE:-} ARGS=$*" >> ${JSON.stringify(log)}
name=""
for a in "$@"; do
  case "$a" in
    --name=*) name="\${a#--name=}" ;;
    --secret=*) name="\${a#--secret=}" ;;
    */slack-*|*/github-pat|*/anthropic-api-key) name="\${a##*/}" ;;
  esac
done
prev=""
for a in "$@"; do [ "$prev" = "--name" ] && name="$a"; prev="$a"; done
[ "$1" = login ] && exit 0
case "$name" in
${Object.entries(errors).map(([k, v]) => `  ${k}) echo ${JSON.stringify(v)} >&2; exit 1 ;;`).join('\n')}
${Object.entries(values).filter(([k]) => values[k] !== null).map(([k, v]) => `  ${k}) printf '%s\\n' ${JSON.stringify(v)}; exit 0 ;;`).join('\n')}
esac
case "$cli" in az) echo "ERROR: (SecretNotFound) A secret with name $name was not found" >&2;; aws) echo "An error occurred (ResourceNotFoundException) when calling" >&2;; gcloud) echo "ERROR: NOT_FOUND: Secret not found" >&2;; esac
exit 1
`;
  for (const c of ['az', 'aws', 'gcloud']) fs.writeFileSync(path.join(bin, c), script, { mode: 0o755 });
  fs.writeFileSync(path.join(etc, variant, 'deploy.env'), `AZURE_KEY_VAULT=kv-test\nAWS_SECRET_PREFIX=fix/${variant}\nGCP_PROJECT=proj\n${deployEnv}`);
  const env = { FIX_CODE_DEPLOY_ETC: etc, FIX_CODE_DEPLOY_RUN: run, FIX_CODE_USER: os.userInfo().username, FIX_CODE_DEPLOY_CLI_PATH: `${bin}:/usr/bin:/bin`, PATH: `${bin}:${process.env.PATH}`, HOME: home };
  return { base, etc, run, bin, home, log, env, runDir: path.join(run, variant), go: (args = []) => sh('bin/fetch-secrets.sh', [variant, ...args], env) };
}
const mode = f => fs.statSync(f).mode & 0o777;

test('azure path writes secrets.env and gh-token with mode 0600', t => {
  const fx = fixture(t);
  const r = fx.go();
  assert.equal(r.status, 0, r.stderr);
  const env = path.join(fx.runDir, 'secrets.env');
  assert.equal(fs.readFileSync(env, 'utf8'), 'SLACK_BOT_TOKEN=xoxb-1\nSLACK_APP_TOKEN=xapp-1\nANTHROPIC_API_KEY=sk-1\n');
  assert.equal(fs.readFileSync(path.join(fx.runDir, 'gh-token'), 'utf8'), 'ghp_1\n');
  assert.equal(mode(env), 0o600); assert.equal(mode(path.join(fx.runDir, 'gh-token')), 0o600);
  assert.ok(!r.stdout.includes('xoxb') && !r.stderr.includes('xoxb'));
  assert.ok(fs.readFileSync(fx.log, 'utf8').includes('ARGS=keyvault secret show --vault-name kv-test'));
});

test('FIX_CODE_SECRET_PROVIDER in deploy.env selects aws; --provider overrides it', t => {
  const fx = fixture(t, { deployEnv: 'FIX_CODE_SECRET_PROVIDER=aws\n' });
  assert.equal(fx.go().status, 0);
  let log = fs.readFileSync(fx.log, 'utf8');
  assert.ok(/^aws /m.test(log) && !/^az /m.test(log), log);
  fs.rmSync(fx.log);
  assert.equal(fx.go(['--provider', 'gcp']).status, 0);
  log = fs.readFileSync(fx.log, 'utf8');
  assert.ok(/^gcloud /m.test(log) && !/^aws /m.test(log));
});

test('a required secret that is not found fails and leaves files untouched', t => {
  const fx = fixture(t, { deployEnv: 'REQUIRED_SECRETS="github-pat"\n', fakes: { values: { 'github-pat': null } } });
  fs.mkdirSync(fx.runDir, { recursive: true });
  fs.writeFileSync(path.join(fx.runDir, 'secrets.env'), 'OLD=1\n'); fs.writeFileSync(path.join(fx.runDir, 'gh-token'), 'oldtoken\n');
  const r = fx.go();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /github-pat/);
  assert.equal(fs.readFileSync(path.join(fx.runDir, 'secrets.env'), 'utf8'), 'OLD=1\n');
  assert.equal(fs.readFileSync(path.join(fx.runDir, 'gh-token'), 'utf8'), 'oldtoken\n');
});

test('an optional secret confirmed absent removes the stale gh-token and the API key line', t => {
  for (const provider of ['azure', 'aws', 'gcp']) {
    const fx = fixture(t, { deployEnv: `FIX_CODE_SECRET_PROVIDER=${provider}\n`, fakes: { values: { 'github-pat': null, 'anthropic-api-key': null } } });
    fs.mkdirSync(fx.runDir, { recursive: true });
    fs.writeFileSync(path.join(fx.runDir, 'gh-token'), 'stale\n');
    const r = fx.go();
    assert.equal(r.status, 0, provider + r.stderr);
    assert.ok(!fs.existsSync(path.join(fx.runDir, 'gh-token')), provider);
    assert.equal(fs.readFileSync(path.join(fx.runDir, 'secrets.env'), 'utf8'), 'SLACK_BOT_TOKEN=xoxb-1\nSLACK_APP_TOKEN=xapp-1\n');
  }
});

test('a non-not-found error on an optional secret fails', t => {
  const fx = fixture(t, { fakes: { errors: { 'github-pat': 'ERROR: (AuthorizationFailed) no access' } } });
  fs.mkdirSync(fx.runDir, { recursive: true });
  fs.writeFileSync(path.join(fx.runDir, 'gh-token'), 'keep\n');
  const r = fx.go();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /github-pat/); assert.match(r.stderr, /AuthorizationFailed/); assert.match(r.stderr, /azure/);
  assert.equal(fs.readFileSync(path.join(fx.runDir, 'gh-token'), 'utf8'), 'keep\n');
  assert.ok(!fs.existsSync(path.join(fx.runDir, 'secrets.env')));
});

test('CLIs run with a scrubbed HOME, not the planted service-user HOME', t => {
  const fx = fixture(t, { deployEnv: 'FIX_CODE_SECRET_PROVIDER=aws\n' });
  const r = sh('bin/fetch-secrets.sh', [variant], { ...fx.env, AWS_CONFIG_FILE: path.join(fx.home, '.aws', 'config') });
  assert.equal(r.status, 0, r.stderr);
  const log = fs.readFileSync(fx.log, 'utf8');
  assert.ok(log.includes('aws HOME='));
  assert.ok(!log.includes(`HOME=${fx.home} `), log);
  assert.ok(!log.includes(`AWS_CONFIG_FILE=${fx.home}`), log);
  assert.ok(!fs.existsSync(path.join(fx.base, 'PWNED')));
});

test('GITHUB_TOKEN_SOURCE=external never writes gh-token', t => {
  const fx = fixture(t, { deployEnv: 'GITHUB_TOKEN_SOURCE=external\n' });
  const r = fx.go();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(fx.runDir, 'gh-token')));
  assert.ok(!fs.readFileSync(fx.log, 'utf8').includes('github-pat'));
  assert.ok(fs.existsSync(path.join(fx.runDir, 'secrets.env')));
});

test('provision.sh with --foundry-resource-id prints the Cognitive Services role; bad vault names are rejected', () => {
  const ok = sh('azure/provision.sh', ['--dry-run', '--variant', variant, '--foundry-resource-id', foundryId]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(ok.stdout.includes('Cognitive Services User') && ok.stdout.includes(foundryId));
  assert.ok(ok.stdout.indexOf('Key Vault Secrets User') < ok.stdout.indexOf('Cognitive Services User'));
  assert.ok(ok.stdout.includes('--generate-ssh-keys') && ok.stdout.includes('--admin-username azureuser'));
  assert.match(ok.stdout, /--name kv-[a-z0-9]+-[0-9a-f]{4} /);
  for (const v of ['ab', '1abc', 'a_b_c', 'a'.repeat(25), 'kv name']) assert.notEqual(sh('azure/provision.sh', ['--dry-run', '--variant', variant, '--vault', v]).status, 0, v);
  assert.equal(sh('azure/provision.sh', ['--dry-run', '--variant', variant, '--vault', 'kv-good-1']).status, 0);
  assert.notEqual(sh('azure/provision.sh', ['--dry-run', '--variant', variant, '--foundry-resource-id', 'f1']).status, 0);
});

test('cloud-init keeps the default user, installs the Azure CLI and writes .gitconfig', () => {
  const y = fs.readFileSync(path.join(deploy, 'cloud-init', 'fix-code-bridge.yaml'), 'utf8');
  assert.match(y, /users:\n(  #.*\n)*  - default\n/);
  assert.ok(y.includes('InstallAzureCLIDeb'));
  assert.ok(y.includes('/var/lib/VARIANT/.gitconfig') && y.includes('helper = !/usr/bin/gh auth git-credential'));
});
