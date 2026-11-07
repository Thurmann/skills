import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resolveModels } from '../src/config.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-code-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { teamId: 'T123', allowedUsers: ['U123'], allowedChannels: ['C123'], runtime: 'codex', allowNetwork: true, skillPath: path.resolve(import.meta.dirname, '../skills/fix-code'), models: { codex: { architect: 'strong', implementer: 'cheap', reviewer: 'strong' } }, allowedModels: { codex: ['strong', 'cheap'] }, repositories: { app: { path: dir, base: 'origin/main', baseBranch: 'main', remote: 'origin', github: 'example/app' } } };
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
  assert.deepEqual(resolveModels(config, 'codex', { all: 'cheap', architect: 'strong' }), { architect: 'strong', implementer: 'cheap', reviewer: 'cheap' });
  assert.throws(() => resolveModels(config, 'codex', { implementer: 'untrusted' }), /not allowlisted/);
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
