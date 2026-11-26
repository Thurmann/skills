import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { command, configureGitHubAuth, readGitHubToken } from '../src/git.js';

const MINUTE = 60000;
// Fake CLI: records each run in a marker file and prints the token variables it received.
const fakeCli = marker => `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(marker)}, 'ran\\n');\nconsole.log(JSON.stringify({ GH_TOKEN: process.env.GH_TOKEN ?? null, GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? null }));\n`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-code-github-auth-'));
  const saved = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  process.env.GH_TOKEN = 'stale-env'; process.env.GITHUB_TOKEN = 'stale-env-2';
  t.after(() => {
    configureGitHubAuth({});
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const f = { root, gh: path.join(bin, 'gh'), tool: path.join(bin, 'tool'), ghMarker: path.join(root, 'gh-ran'), toolMarker: path.join(root, 'tool-ran'), tokenFile: path.join(root, 'gh-token') };
  fs.writeFileSync(f.gh, fakeCli(f.ghMarker), { mode: 0o700 });
  fs.writeFileSync(f.tool, fakeCli(f.toolMarker), { mode: 0o700 });
  return f;
}

test('each gh spawn reads the token file fresh and ignores environment tokens', async t => {
  const f = fixture(t);
  configureGitHubAuth({ githubTokenFile: f.tokenFile, ghPath: f.gh });
  fs.writeFileSync(f.tokenFile, 'ghs_first\n');
  assert.deepEqual(JSON.parse(await command(f.gh, ['api'])), { GH_TOKEN: 'ghs_first', GITHUB_TOKEN: null });
  fs.writeFileSync(f.tokenFile, '  ghs_second  \n');
  assert.deepEqual(JSON.parse(await command(f.gh, ['api'])), { GH_TOKEN: 'ghs_second', GITHUB_TOKEN: null });
});

test('other executables never receive a GitHub token, even when the token file is gone', async t => {
  const f = fixture(t);
  configureGitHubAuth({ githubTokenFile: f.tokenFile, ghPath: f.gh });
  fs.writeFileSync(f.tokenFile, 'ghs_first\n');
  assert.deepEqual(JSON.parse(await command(f.tool, [])), { GH_TOKEN: null, GITHUB_TOKEN: null });
  fs.rmSync(f.tokenFile);
  assert.deepEqual(JSON.parse(await command(f.tool, [])), { GH_TOKEN: null, GITHUB_TOKEN: null });
  assert.equal(fs.existsSync(f.toolMarker), true);
});

test('invalid token files reject before spawning gh and never echo token contents', async t => {
  const f = fixture(t);
  configureGitHubAuth({ githubTokenFile: f.tokenFile, ghPath: f.gh });
  const cases = [
    [undefined, /missing/],
    ['\n  \n', /empty/],
    ['ghs_secretA ghs_secretB\n', /exactly one token/],
    [null, /not a regular file/]
  ];
  for (const [content, pattern] of cases) {
    fs.rmSync(f.tokenFile, { recursive: true, force: true });
    if (content === null) fs.mkdirSync(f.tokenFile);
    else if (content !== undefined) fs.writeFileSync(f.tokenFile, content);
    await assert.rejects(command(f.gh, ['api']), error => {
      assert.match(error.message, pattern);
      assert.ok(error.message.includes(f.tokenFile));
      assert.doesNotMatch(error.message, /ghs_secret|stale-env/);
      return true;
    });
  }
  assert.equal(fs.existsSync(f.ghMarker), false);
});

test('without a token file the inherited environment passes through unchanged', async t => {
  const f = fixture(t);
  configureGitHubAuth({});
  assert.deepEqual(JSON.parse(await command(f.gh, ['api'])), { GH_TOKEN: 'stale-env', GITHUB_TOKEN: 'stale-env-2' });
});

test('app mode rejects a token file older than one hour and readGitHubToken applies the 55 minute doctor limit', async t => {
  const f = fixture(t);
  configureGitHubAuth({ githubTokenFile: f.tokenFile, githubAuth: 'app', ghPath: f.gh });
  fs.writeFileSync(f.tokenFile, 'ghs_app\n');
  const setAge = minutes => { const when = new Date(Date.now() - minutes * MINUTE); fs.utimesSync(f.tokenFile, when, when); };
  setAge(61);
  await assert.rejects(command(f.gh, ['api']), /minutes old \(limit 60\)/);
  assert.equal(fs.existsSync(f.ghMarker), false);

  const now = Date.now();
  // One second inside the limit: an mtime set to exactly 55 minutes can read back a
  // fraction of a millisecond older on Linux, which made this assertion flaky in CI.
  const inside = new Date(now - 55 * MINUTE + 1000);
  fs.utimesSync(f.tokenFile, inside, inside);
  assert.equal(readGitHubToken(f.tokenFile, { maxAgeMs: 55 * MINUTE, now }), 'ghs_app');
  fs.utimesSync(f.tokenFile, new Date(now - 56 * MINUTE), new Date(now - 56 * MINUTE));
  assert.throws(() => readGitHubToken(f.tokenFile, { maxAgeMs: 55 * MINUTE, now }), /minutes old \(limit 55\)/);
  assert.equal(readGitHubToken(f.tokenFile), 'ghs_app');
});
