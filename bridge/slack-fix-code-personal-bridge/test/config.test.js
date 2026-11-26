import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfigApi } from 'slack-bridge-core/config.js';
import profile from '../src/profile.js';

const { configHome, findConfig, loadConfig, defaultSkill } = createConfigApi(profile);

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-code-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { teamId: 'T123', allowedUsers: ['U123'], allowedChannels: ['C123'], runtime: 'codex', allowNetwork: true, skillPath: path.resolve(import.meta.dirname, '../../../skills/fix-code'), models: { codex: { architect: 'strong', implementer: 'cheap', reviewer: 'strong' } }, allowedModels: { codex: ['strong', 'cheap'] }, repositories: { app: { path: dir, base: 'origin/main', baseBranch: 'main', remote: 'origin', github: 'example/app' } } };
  const filename = path.join(dir, 'config.json');
  const save = () => { fs.writeFileSync(filename, JSON.stringify(config)); return filename; };
  return { dir, config, save };
}

test('findConfig prefers --config, FIX_CODE_CONFIG, ./config.json, then the user config directory', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-code-find-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'cwd'), xdg = path.join(root, 'xdg'), env = { XDG_CONFIG_HOME: xdg };
  fs.mkdirSync(cwd); fs.mkdirSync(path.join(xdg, 'fix-code-bridge'), { recursive: true });
  assert.equal(configHome(env), path.join(xdg, 'fix-code-bridge'));
  assert.throws(() => findConfig(undefined, env, cwd), /No config.json found. Looked in: .*cwd.*fix-code-bridge/);
  fs.writeFileSync(path.join(xdg, 'fix-code-bridge', 'config.json'), '{}');
  assert.equal(findConfig(undefined, env, cwd), path.join(xdg, 'fix-code-bridge', 'config.json'));
  fs.writeFileSync(path.join(cwd, 'config.json'), '{}');
  assert.equal(findConfig(undefined, env, cwd), path.join(cwd, 'config.json'));
  assert.equal(findConfig(undefined, { ...env, FIX_CODE_CONFIG: 'other.json' }, cwd), path.join(cwd, 'other.json'));
  assert.equal(findConfig('/x/explicit.json', { ...env, FIX_CODE_CONFIG: 'other.json' }, cwd), '/x/explicit.json');
});

test('a config without skillPath uses the repository skill', t => {
  const f = fixture(t); delete f.config.skillPath;
  assert.equal(loadConfig(f.save()).skillPath, defaultSkill);
});

test('GitHub token file and githubAuth settings are rejected because this bridge only supports the signed-in gh user', t => {
  const f = fixture(t);
  f.config.githubTokenFile = './token';
  assert.throws(() => loadConfig(f.save()), /githubTokenFile is not supported by the personal-local bridge\./);
  delete f.config.githubTokenFile; f.config.githubAuth = 'app';
  assert.throws(() => loadConfig(f.save()), /githubAuth is not supported by the personal-local bridge\./);
});
