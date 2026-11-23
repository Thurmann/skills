import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfigApi, validateProfile } from '../src/config.js';

const skillPath = path.resolve(import.meta.dirname, '../../../skills/fix-code');
const make = (id, over = {}) => ({
  id, configDirName: `${id}-dir`, configEnvVar: `${id.toUpperCase().replace(/-/g, '_')}_CONFIG`, packageDir: import.meta.dirname, defaultSkillPath: skillPath,
  github: { modes: ['user'], tokenFile: false, requireTokenFile: false, forbidRuntimeTokenEnv: false }, routing: { localRoot: true, aliases: true }, ...over
});
const personal = make('personal-local');
const company = make('company', { github: { modes: ['user', 'app'], tokenFile: true, requireTokenFile: false, forbidRuntimeTokenEnv: true } });
const noLocal = make('personal-cloud', { routing: { localRoot: false, aliases: true }, github: { modes: ['user'], tokenFile: true, requireTokenFile: false, forbidRuntimeTokenEnv: true } });
const cloud = make('personal-cloud', { routing: { localRoot: false, aliases: false }, github: { modes: ['user'], tokenFile: true, requireTokenFile: true, forbidRuntimeTokenEnv: true } });

function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-profile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { teamId: 'T123', allowedUsers: ['U123'], allowedChannels: ['C123'], runtime: 'codex', allowNetwork: true, skillPath, models: { codex: { architect: 'strong', implementer: 'cheap', reviewer: 'strong' } }, allowedModels: { codex: ['strong', 'cheap'] }, repositories: { app: { path: dir, base: 'origin/main', baseBranch: 'main', remote: 'origin', github: 'example/app' } }, ...extra };
  const filename = path.join(dir, 'config.json');
  fs.writeFileSync(filename, JSON.stringify(config));
  return filename;
}

test('githubTokenFile is rejected by profiles without token file support and accepted otherwise', t => {
  assert.throws(() => createConfigApi(personal).loadConfig(fixture(t, { githubTokenFile: './token' })), /githubTokenFile is not supported by the personal-local bridge\./);
  const config = createConfigApi(company).loadConfig(fixture(t, { githubTokenFile: './token' }));
  assert.equal(path.basename(config.githubTokenFile), 'token');
});

test('githubAuth is rejected entirely by user-only profiles without token files', t => {
  assert.throws(() => createConfigApi(personal).loadConfig(fixture(t, { githubAuth: 'user' })), /githubAuth is not supported by the personal-local bridge\./);
});

test('app mode is rejected when the profile does not list it', t => {
  assert.throws(() => createConfigApi(noLocal).loadConfig(fixture(t, { githubAuth: 'app', githubTokenFile: './token' })), /githubAuth "app" is not supported by the personal-cloud bridge\./);
  assert.equal(createConfigApi(company).loadConfig(fixture(t, { githubAuth: 'app', githubTokenFile: './token' })).githubAuth, 'app');
});

test('repositoryRouting.localRoot is rejected when the profile disallows it', t => {
  const extra = { repositoryRouting: { mode: 'channel', localRoot: os.tmpdir() } };
  assert.throws(() => createConfigApi(noLocal).loadConfig(fixture(t, extra)), /repositoryRouting\.localRoot is not supported by the personal-cloud bridge\./);
  assert.equal(createConfigApi(personal).loadConfig(fixture(t, extra)).repositoryRouting.localRoot, fs.realpathSync(os.tmpdir()));
});

test('GH_TOKEN and GITHUB_TOKEN runtime env names are forbidden only when the profile says so', t => {
  const extra = { runtimes: { codex: { env: ['GH_TOKEN'] } } };
  assert.throws(() => createConfigApi(company).loadConfig(fixture(t, extra)), /runtimes\.codex\.env must list environment variable names \(not SLACK_\*, GH_TOKEN or GITHUB_TOKEN\)\./);
  assert.deepEqual(createConfigApi(personal).loadConfig(fixture(t, extra)).runtimes.codex.env, ['GH_TOKEN']);
  assert.throws(() => createConfigApi(personal).loadConfig(fixture(t, { runtimes: { codex: { env: ['SLACK_BOT_TOKEN'] } } })), /\(not SLACK_\*\)\./);
});

test('configHome and findConfig use the profile directory name and environment variable', t => {
  const api = createConfigApi(company);
  assert.equal(api.configHome({ XDG_CONFIG_HOME: '/x' }), path.join('/x', 'company-dir'));
  assert.equal(api.findConfig(undefined, { COMPANY_CONFIG: 'a.json' }, '/cwd'), path.resolve('/cwd', 'a.json'));
  assert.equal(createConfigApi(personal).findConfig(undefined, { PERSONAL_LOCAL_CONFIG: 'b.json' }, '/cwd'), path.resolve('/cwd', 'b.json'));
  assert.equal(api.defaultSkill, skillPath);
});

test('validateProfile rejects malformed profiles', () => {
  assert.equal(validateProfile(company), company);
  assert.throws(() => validateProfile(null), /must be an object/);
  assert.throws(() => validateProfile({ ...company, id: '' }), /id must be a nonempty string/);
  assert.throws(() => validateProfile({ ...company, github: { ...company.github, modes: ['app'] } }), /github\.modes/);
  assert.throws(() => validateProfile({ ...company, github: { ...company.github, modes: ['user', 'x'] } }), /github\.modes/);
  assert.throws(() => validateProfile({ ...company, github: { ...company.github, tokenFile: 'yes' } }), /booleans/);
  assert.throws(() => validateProfile({ ...personal, github: { ...personal.github, modes: ['user', 'app'] } }), /requires github\.tokenFile/);
  assert.throws(() => validateProfile({ ...company, routing: {} }), /routing\.localRoot/);
  assert.throws(() => validateProfile({ ...company, routing: { localRoot: true } }), /routing\.aliases/);
  assert.throws(() => validateProfile({ ...company, routing: { localRoot: true, aliases: 'yes' } }), /routing\.aliases/);
  assert.throws(() => validateProfile({ ...company, github: { ...company.github, requireTokenFile: undefined } }), /requireTokenFile/);
  assert.throws(() => validateProfile({ ...personal, github: { ...personal.github, requireTokenFile: 1 } }), /requireTokenFile/);
  assert.throws(() => validateProfile({ ...personal, github: { ...personal.github, requireTokenFile: true } }), /requireTokenFile requires github\.tokenFile/);
  assert.equal(validateProfile(cloud), cloud);
});

test('requireTokenFile makes githubTokenFile mandatory without changing other profiles', t => {
  const channel = { repositories: {}, repositoryRouting: { mode: 'channel' } };
  assert.throws(() => createConfigApi(cloud).loadConfig(fixture(t, channel)), /githubTokenFile is required by the personal-cloud bridge\./);
  assert.equal(path.basename(createConfigApi(cloud).loadConfig(fixture(t, { ...channel, githubTokenFile: './token' })).githubTokenFile), 'token');
  assert.equal(createConfigApi(company).loadConfig(fixture(t)).githubTokenFile, undefined);
  assert.equal(createConfigApi(personal).loadConfig(fixture(t)).githubAuth, 'user');
});

test('aliases: false rejects alias routing and a repositories map but keeps channel mode', t => {
  const base = { githubTokenFile: './token' };
  assert.throws(() => createConfigApi(cloud).loadConfig(fixture(t, { ...base, repositoryRouting: { mode: 'aliases' } })), /repositoryRouting\.mode "aliases" is not supported by the personal-cloud bridge\./);
  // default mode resolves to aliases when a repositories map is present
  assert.throws(() => createConfigApi(cloud).loadConfig(fixture(t, base)), /repositoryRouting\.mode "aliases" is not supported by the personal-cloud bridge\./);
  assert.throws(() => createConfigApi(cloud).loadConfig(fixture(t, { ...base, repositoryRouting: { mode: 'channel' } })), /repositories .* not supported by the personal-cloud bridge\./);
  const ok = createConfigApi(cloud).loadConfig(fixture(t, { ...base, repositories: {} }));
  assert.equal(ok.repositoryRouting.mode, 'channel');
  assert.equal(createConfigApi(personal).loadConfig(fixture(t)).repositoryRouting.mode, 'aliases');
});
