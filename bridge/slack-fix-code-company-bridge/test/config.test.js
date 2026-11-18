import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resolveModels, selectDefaultRuntime, findConfig, loadEnvBeside, configHome, defaultSkill } from '../src/config.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-code-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { teamId: 'T123', allowedUsers: ['U123'], allowedChannels: ['C123'], runtime: 'codex', allowNetwork: true, skillPath: path.resolve(import.meta.dirname, '../../../skills/fix-code'), models: { codex: { architect: 'strong', implementer: 'cheap', reviewer: 'strong' } }, allowedModels: { codex: ['strong', 'cheap'] }, repositories: { app: { path: dir, base: 'origin/main', baseBranch: 'main', remote: 'origin', github: 'example/app' } } };
  const filename = path.join(dir, 'config.json');
  const save = () => { fs.writeFileSync(filename, JSON.stringify(config)); return filename; };
  return { dir, config, save };
}

test('configuration requires explicit allowlists and resolves paths relative to its file', t => {
  const f = fixture(t); const parsed = loadConfig(f.save());
  assert.equal(parsed.stateDir, path.join(f.dir, 'state'));
  f.config.allowedUsers = []; assert.throws(() => loadConfig(f.save()), /nonempty allowlist/);
});

test('allowedChannels accepts a sole wildcard and rejects mixed or malformed wildcard entries', t => {
  const f = fixture(t);
  f.config.allowedChannels = ['*'];
  assert.deepEqual(loadConfig(f.save()).allowedChannels, ['*']);
  f.config.allowedChannels = ['*', 'C123'];
  assert.throws(() => loadConfig(f.save()), /wildcard must be the sole entry/);
  f.config.allowedChannels = ['C123', '*'];
  assert.throws(() => loadConfig(f.save()), /wildcard must be the sole entry/);
  f.config.allowedChannels = ['not-a-channel'];
  assert.throws(() => loadConfig(f.save()), /Invalid allowedChannels/);
});

test('example placeholders, arbitrary paths, and unknown default models fail before connection', t => {
  const f = fixture(t);
  f.config.teamId = 'T_REPLACE'; assert.throws(() => loadConfig(f.save()), /Slack team/);
  f.config.teamId = 'T123'; f.config.repositories.app.path = '/definitely/not/present/fix-code'; assert.throws(() => loadConfig(f.save()), /Repository path missing/);
  f.config.repositories.app.path = f.dir; f.config.models.codex.implementer = 'not-approved'; assert.throws(() => loadConfig(f.save()), /model allowlist/);
});

test('per-role override wins over all-role override, while unsupported models fail closed', t => {
  const f = fixture(t); const config = loadConfig(f.save());
  assert.deepEqual(resolveModels(config, 'codex', { all: 'cheap', architect: 'strong' }), { precheck: 'cheap', architect: 'strong', implementer: 'cheap', reviewer: 'cheap' });
  assert.throws(() => resolveModels(config, 'codex', { implementer: 'untrusted' }), /not allowlisted/);
});

test('precheck falls back to implementer, is allowlisted when explicit, and older tasks resolve it too', t => {
  const f = fixture(t);
  assert.equal(loadConfig(f.save()).models.codex.precheck, 'cheap');
  assert.equal(resolveModels(loadConfig(f.save()), 'codex', {}, { architect: 'strong', implementer: 'cheap', reviewer: 'strong' }).precheck, 'cheap');
  f.config.models.codex.precheck = 'untrusted'; assert.throws(() => loadConfig(f.save()), /model allowlist/);
});

test('channel routing needs no aliases and normalizes repository discovery settings', t => {
  const f = fixture(t);
  delete f.config.repositories;
  f.config.repositoryRouting = { mode: 'channel', allowedOwners: ['ExampleOrg'], channelOwners: { C123: 'exampleorg' } };
  f.config.allowNetwork = false;
  const parsed = loadConfig(f.save());
  assert.equal(parsed.repositoryRouting.mode, 'channel');
  assert.equal(parsed.repositoryRouting.cloneRoot, path.join(f.dir, 'state', 'repositories'));
  assert.deepEqual(parsed.repositories, {});
  assert.deepEqual(parsed.repositoryRouting.allowedOwners, ['ExampleOrg']);
  assert.equal(parsed.repositoryRouting.channelOwners.C123, 'exampleorg');
});

test('legacy configs infer aliases mode, while empty legacy maps infer channel mode', t => {
  const f = fixture(t);
  const legacy = loadConfig(f.save());
  assert.equal(legacy.repositoryRouting.mode, 'aliases');
  assert.deepEqual(legacy.repositoryRouting.allowedOwners, []);

  f.config.repositories = {};
  const noAliases = loadConfig(f.save());
  assert.equal(noAliases.repositoryRouting.mode, 'channel');
  assert.deepEqual(noAliases.repositories, {});
});

test('channel routing validates mode, allowed owners, channel IDs, owner hints, and clone root', t => {
  const f = fixture(t);
  delete f.config.repositories;
  f.config.repositoryRouting = { mode: 'unknown' };
  assert.throws(() => loadConfig(f.save()), /mode must be channel or aliases/);

  f.config.repositoryRouting = { mode: 'channel', allowedOwners: ['bad/name'] };
  assert.throws(() => loadConfig(f.save()), /valid GitHub owner names/);
  f.config.repositoryRouting = { mode: 'channel', allowedOwners: ['allowed'], channelOwners: { notAChannel: 'allowed' } };
  assert.throws(() => loadConfig(f.save()), /channel ID/);
  f.config.repositoryRouting = { mode: 'channel', allowedOwners: ['allowed'], channelOwners: { C123: 'other' } };
  assert.throws(() => loadConfig(f.save()), /not in allowedOwners/);
  f.config.repositoryRouting = { mode: 'channel', cloneRoot: os.homedir() };
  assert.throws(() => loadConfig(f.save()), /cannot be a filesystem, home/);
});

test('localRoot is optional, expands home paths, and must already be a directory', t => {
  const f = fixture(t); delete f.config.repositories;
  f.config.repositoryRouting = { mode: 'channel', localRoot: f.dir };
  assert.equal(loadConfig(f.save()).repositoryRouting.localRoot, fs.realpathSync(f.dir));
  f.config.repositoryRouting.localRoot = path.join(f.dir, 'missing');
  assert.throws(() => loadConfig(f.save()), /existing directory/);
  delete f.config.repositoryRouting.localRoot;
  assert.equal(loadConfig(f.save()).repositoryRouting.localRoot, undefined);
});

const claudeModels = { architect: 'opus', implementer: 'sonnet', reviewer: 'opus' };

test('legacy layout is normalized into runtimes and keeps path keys', t => {
  const f = fixture(t); f.config.claudePath = '/bin/claude-x';
  const c = loadConfig(f.save());
  assert.deepEqual(Object.keys(c.runtimes), ['codex']);
  assert.equal(c.runtimes.codex.path, 'codex'); assert.equal(c.codexPath, 'codex');
  assert.equal(c.claudePath, '/bin/claude-x'); assert.equal(c.runtimeExplicit, true);
  assert.deepEqual(c.runtimePriority, ['claude', 'codex', 'gemini', 'opencode']);
});

test('runtimes layout overrides legacy keys, validates env and rejects unknown providers or priorities', t => {
  const f = fixture(t); delete f.config.runtime; delete f.config.models; delete f.config.allowedModels;
  f.config.runtimes = { claude: { path: '/opt/claude', models: claudeModels, allowedModels: ['opus', 'sonnet'], env: ['MY_KEY'] }, codex: { models: { architect: 'strong', implementer: 'cheap', reviewer: 'strong' }, allowedModels: ['strong', 'cheap'] } };
  const c = loadConfig(f.save());
  assert.equal(c.runtimeExplicit, false); assert.equal(c.runtime, undefined);
  assert.equal(c.runtimes.claude.path, '/opt/claude'); assert.deepEqual(c.runtimes.claude.env, ['MY_KEY']);
  assert.equal(c.models.claude.precheck, 'sonnet'); assert.deepEqual(c.allowedModels.codex, ['strong', 'cheap']);
  f.config.runtimes.claude.env = ['SLACK_BOT_TOKEN']; assert.throws(() => loadConfig(f.save()), /environment variable names/);
  f.config.runtimes.claude.env = ['GH_TOKEN']; assert.throws(() => loadConfig(f.save()), /environment variable names/);
  f.config.runtimes.claude.env = ['GITHUB_TOKEN']; assert.throws(() => loadConfig(f.save()), /environment variable names/);
  f.config.runtimes.claude.env = ['lower']; assert.throws(() => loadConfig(f.save()), /environment variable names/);
  f.config.runtimes.claude.env = [];
  f.config.runtimes.bogus = {}; assert.throws(() => loadConfig(f.save()), /Unknown runtime/); delete f.config.runtimes.bogus;
  f.config.runtimePriority = ['claude', 'claude']; assert.throws(() => loadConfig(f.save()), /runtimePriority/);
  f.config.runtimePriority = ['nope']; assert.throws(() => loadConfig(f.save()), /runtimePriority/);
  f.config.runtimePriority = ['codex']; assert.deepEqual(loadConfig(f.save()).runtimePriority, ['codex', 'claude']);
  f.config.runtime = 'gemini'; assert.throws(() => loadConfig(f.save()), /models.gemini is required/);
  f.config.runtime = 'nope'; assert.throws(() => loadConfig(f.save()), /runtime must be one of/);
});

test('selectDefaultRuntime honors override, explicit runtime, then priority among available providers', async t => {
  const f = fixture(t); delete f.config.runtime;
  f.config.runtimes = { claude: { models: claudeModels, allowedModels: ['opus', 'sonnet'] } };
  const c = loadConfig(f.save());
  const up = names => async name => names.includes(name);
  assert.equal(await selectDefaultRuntime(c, { isAvailable: up(['claude', 'codex']) }), 'claude');
  assert.deepEqual(c.availableRuntimes, ['claude', 'codex']);
  assert.equal(await selectDefaultRuntime(c, { isAvailable: up(['codex']) }), 'codex');
  assert.equal(await selectDefaultRuntime(c, { override: 'codex', isAvailable: up(['claude', 'codex']) }), 'codex');
  await assert.rejects(selectDefaultRuntime(c, { override: 'claude', isAvailable: up(['codex']) }), /not available/);
  await assert.rejects(selectDefaultRuntime(c, { override: 'gemini', isAvailable: up(['codex']) }), /not configured/);
  await assert.rejects(selectDefaultRuntime(c, { isAvailable: up([]) }), /No configured provider CLI/);
  c.runtimeExplicit = true; c.runtime = 'codex';
  assert.equal(await selectDefaultRuntime(c, { isAvailable: up(['claude', 'codex']) }), 'codex');
  await assert.rejects(selectDefaultRuntime(c, { isAvailable: up(['claude']) }), /not available/);
});

test('selectDefaultRuntime falls through the whole priority list when no runtime is chosen', async t => {
  const f = fixture(t); delete f.config.runtime;
  const roles = model => ({ precheck: model, architect: model, implementer: model, reviewer: model });
  f.config.runtimes = { claude: { models: claudeModels, allowedModels: ['opus', 'sonnet'] }, gemini: { models: roles('flash'), allowedModels: ['flash'] }, opencode: { models: roles('a/b'), allowedModels: ['a/b'] } };
  const c = loadConfig(f.save());
  const up = names => async name => names.includes(name);
  assert.equal(await selectDefaultRuntime(c, { isAvailable: up(['gemini', 'opencode']) }), 'gemini');
  assert.equal(await selectDefaultRuntime(c, { isAvailable: up(['opencode']) }), 'opencode');
  assert.deepEqual(c.availableRuntimes, ['opencode']);
});

test('findConfig prefers --config, FIX_CODE_COMPANY_CONFIG, ./config.json, then the user config directory', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-code-find-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'cwd'), xdg = path.join(root, 'xdg'), env = { XDG_CONFIG_HOME: xdg };
  fs.mkdirSync(cwd); fs.mkdirSync(path.join(xdg, 'fix-code-company-bridge'), { recursive: true });
  assert.equal(configHome(env), path.join(xdg, 'fix-code-company-bridge'));
  assert.throws(() => findConfig(undefined, env, cwd), /No config.json found. Looked in: .*cwd.*fix-code-company-bridge/);
  fs.writeFileSync(path.join(xdg, 'fix-code-company-bridge', 'config.json'), '{}');
  assert.equal(findConfig(undefined, env, cwd), path.join(xdg, 'fix-code-company-bridge', 'config.json'));
  fs.writeFileSync(path.join(cwd, 'config.json'), '{}');
  assert.equal(findConfig(undefined, env, cwd), path.join(cwd, 'config.json'));
  assert.equal(findConfig(undefined, { ...env, FIX_CODE_COMPANY_CONFIG: 'other.json' }, cwd), path.join(cwd, 'other.json'));
  assert.equal(findConfig('/x/explicit.json', { ...env, FIX_CODE_COMPANY_CONFIG: 'other.json' }, cwd), '/x/explicit.json');
});

test('loadEnvBeside reads the .env next to the config without overriding set variables', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-code-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.json');
  assert.equal(loadEnvBeside(configPath, {}), null);
  fs.writeFileSync(path.join(dir, '.env'), 'SLACK_BOT_TOKEN=xoxb-file\nSLACK_APP_TOKEN=xapp-file\n');
  const env = { SLACK_BOT_TOKEN: 'xoxb-already-set' };
  assert.equal(loadEnvBeside(configPath, env), path.join(dir, '.env'));
  assert.deepEqual(env, { SLACK_BOT_TOKEN: 'xoxb-already-set', SLACK_APP_TOKEN: 'xapp-file' });
});

test('a config without skillPath uses the repository skill', t => {
  const f = fixture(t); delete f.config.skillPath;
  assert.equal(loadConfig(f.save()).skillPath, defaultSkill);
});

test('GitHub auth defaults to user mode, rejects unknown modes, and resolves the token file beside the config', t => {
  const f = fixture(t);
  assert.equal(loadConfig(f.save()).githubAuth, 'user');
  f.config.githubAuth = 'bogus';
  assert.throws(() => loadConfig(f.save()), /githubAuth must be "user" or "app"/);
  f.config.githubAuth = 'user'; f.config.githubTokenFile = './tok';
  assert.equal(loadConfig(f.save()).githubTokenFile, path.join(f.dir, 'tok'));
});

test('app mode requires a token file and a token file cannot be combined with forwarded GitHub auth', t => {
  const f = fixture(t);
  f.config.githubAuth = 'app';
  assert.throws(() => loadConfig(f.save()), /requires githubTokenFile/);
  f.config.githubTokenFile = './tok'; f.config.forwardGitHubAuth = true; f.config.githubAuth = 'user';
  assert.throws(() => loadConfig(f.save()), /forwardGitHubAuth cannot/);
});
