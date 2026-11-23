import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, findConfig, configHome } from '../src/config.js';
import profile from '../src/profile.js';

const exampleFile = path.resolve(import.meta.dirname, '../config.example.json');

// A minimal user-mode cloud config; channel routing needs no local checkout.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-code-cloud-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = {
    teamId: 'T123', allowedUsers: ['U123'], allowedChannels: ['C123'], allowNetwork: true,
    skillPath: path.resolve(import.meta.dirname, '../../../skills/fix-code'),
    runtimes: { claude: { path: 'claude', models: { architect: 'opus', implementer: 'haiku', reviewer: 'opus' }, allowedModels: ['opus', 'haiku'], env: ['ANTHROPIC_API_KEY'] } }
  };
  const filename = path.join(dir, 'config.json');
  const save = () => { fs.writeFileSync(filename, JSON.stringify(config)); return filename; };
  return { dir, config, save };
}

test('profile is cloud-specific: user GitHub mode with a token file, no local routing', () => {
  assert.equal(profile.id, 'personal-cloud');
  assert.deepEqual([...profile.github.modes], ['user']);
  assert.equal(profile.github.tokenFile, true);
  assert.equal(profile.github.forbidRuntimeTokenEnv, true);
  assert.equal(profile.routing.localRoot, false);
});

test('GitHub App mode is rejected by this profile', t => {
  const f = fixture(t);
  f.config.githubAuth = 'app'; f.config.githubTokenFile = './gh-token';
  assert.throws(() => loadConfig(f.save()), /githubAuth "app" is not supported by the personal-cloud bridge/);
});

test('local checkout routing is rejected by this profile', t => {
  const f = fixture(t);
  f.config.repositoryRouting = { mode: 'channel', localRoot: f.dir };
  assert.throws(() => loadConfig(f.save()), /repositoryRouting.localRoot is not supported by the personal-cloud bridge/);
});

test('user mode accepts a personal access token file, resolved beside the config', t => {
  const f = fixture(t);
  assert.equal(loadConfig(f.save()).githubAuth, 'user');
  f.config.githubTokenFile = './gh-token';
  assert.equal(loadConfig(f.save()).githubTokenFile, path.join(f.dir, 'gh-token'));
  f.config.githubTokenFile = '/run/slack-fix-code-personal-cloud-bridge/gh-token';
  assert.equal(loadConfig(f.save()).githubTokenFile, '/run/slack-fix-code-personal-cloud-bridge/gh-token');
});

test('runtimes may not receive GitHub tokens from the environment', t => {
  const f = fixture(t);
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'SLACK_BOT_TOKEN']) {
    f.config.runtimes.claude.env = [name];
    assert.throws(() => loadConfig(f.save()), /environment variable names/, name);
  }
});

test('config home and lookup use the cloud profile name and environment variable', t => {
  const f = fixture(t);
  const xdg = path.join(f.dir, 'xdg');
  const cwd = path.join(f.dir, 'cwd');
  fs.mkdirSync(cwd); fs.mkdirSync(path.join(xdg, 'fix-code-personal-cloud-bridge'), { recursive: true });
  const env = { XDG_CONFIG_HOME: xdg };
  assert.equal(configHome(env), path.join(xdg, 'fix-code-personal-cloud-bridge'));
  assert.throws(() => findConfig(undefined, env, cwd), /No config.json found. Looked in: .*cwd.*fix-code-personal-cloud-bridge/);
  fs.writeFileSync(path.join(xdg, 'fix-code-personal-cloud-bridge', 'config.json'), '{}');
  assert.equal(findConfig(undefined, env, cwd), path.join(xdg, 'fix-code-personal-cloud-bridge', 'config.json'));
  assert.equal(findConfig(undefined, { ...env, FIX_CODE_PERSONAL_CLOUD_CONFIG: 'other.json' }, cwd), path.join(cwd, 'other.json'));
});

test('the example config loads once its three Slack ID placeholders are replaced', t => {
  const f = fixture(t);
  const example = JSON.parse(fs.readFileSync(exampleFile, 'utf8'));
  assert.equal(example.githubAuth, undefined, 'user mode is the default; the example omits githubAuth');
  assert.equal(example.repositoryRouting.localRoot, undefined);
  assert.equal(example.githubTokenFile, '/run/slack-fix-code-personal-cloud-bridge/gh-token');
  assert.throws(() => loadConfig(exampleFile), /Invalid Slack team ID/);
  const filled = { ...example, teamId: 'T123', allowedUsers: ['U123'], allowedChannels: ['C123'] };
  const file = path.join(f.dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(filled));
  const loaded = loadConfig(file);
  assert.equal(loaded.githubAuth, 'user');
  assert.equal(loaded.stateDir, '/var/lib/slack-fix-code-personal-cloud-bridge');
  assert.deepEqual(loaded.runtimes.codex.env, ['OPENAI_API_KEY']);
});
