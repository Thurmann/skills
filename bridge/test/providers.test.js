import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_PRIORITY, getProvider, providerNames } from '../src/providers/index.js';
import { policyToml } from '../src/providers/gemini.js';
import { opencodePermissions } from '../src/providers/opencode.js';

const FORBIDDEN = /^(-y|--yolo|--auto|--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|--allow-dangerously-skip-permissions|yolo|bypassPermissions|danger-full-access)$/;
const PHASES = ['precheck', 'architect', 'implementer', 'reviewer'];

test('registry lists providers in priority order and rejects unknown names', () => {
  assert.deepEqual(providerNames(), ['claude', 'codex', 'gemini', 'opencode']);
  assert.deepEqual(DEFAULT_PRIORITY, providerNames());
  assert.throws(() => getProvider('nope'), /runtime must be one of: claude, codex, gemini, opencode/);
});

test('no provider ever receives a yolo, auto-approve, or permission bypass flag', async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'fix-code-providers-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  for (const name of providerNames()) {
    for (const phase of PHASES) {
      for (const allowNetwork of [true, false]) {
        const args = getProvider(name).buildArgs({ phase, model: 'm', effort: 'high', cwd: '/w', readonly: phase !== 'implementer', gitCommonDir: '/g', allowNetwork, outputDir });
        for (const arg of args) assert.doesNotMatch(arg, FORBIDDEN, `${name}/${phase}: ${arg}`);
      }
    }
  }
});

test('gemini args use plan mode and a policy file for read-only, auto_edit and skip-trust for the implementer', async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'fix-code-gemini-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const gemini = getProvider('gemini');
  const ro = gemini.buildArgs({ model: 'gem', effort: 'high', readonly: true, outputDir });
  assert.equal(ro[ro.indexOf('--approval-mode') + 1], 'plan');
  assert.equal(ro.includes('--skip-trust'), false);
  assert.equal(ro[ro.indexOf('--model') + 1], 'gem');
  assert.equal(ro[ro.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(ro[ro.indexOf('--allowed-mcp-server-names') + 1], '__fix_code_none__');
  assert.equal(ro.some((a) => /effort/.test(a)), false);
  assert.ok(path.isAbsolute(ro[ro.indexOf('--policy') + 1]));
  const impl = gemini.buildArgs({ model: 'gem', readonly: false, outputDir });
  assert.equal(impl[impl.indexOf('--approval-mode') + 1], 'auto_edit');
  assert.equal(impl.includes('--skip-trust'), true);
  for (const readonly of [true, false]) {
    const args = gemini.buildArgs({ model: 'gem', readonly, outputDir, skillPath: '/skills/fix-code' });
    assert.deepEqual(args[args.indexOf('--include-directories') + 1].split(','), ['/skills/fix-code', outputDir]);
  }
  assert.throws(() => gemini.buildArgs({ model: 'gem', readonly: true }), { code: 'INVALID_OUTPUT_DIR' });
  assert.throws(() => gemini.buildArgs({ model: 'gem', readonly: true, outputDir: 'relative' }), { code: 'INVALID_OUTPUT_DIR' });
  await gemini.prepare({ readonly: true, allowNetwork: false, outputDir });
  const file = ro[ro.indexOf('--policy') + 1];
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(await readFile(file, 'utf8'), policyToml({ readonly: true, allowNetwork: false }));
});

test('gemini policy denies writes when read-only, allows them for the implementer, and denies web tools without network', () => {
  const rules = (text) => [...text.matchAll(/toolName = "(\w+)"\ndecision = "(\w+)"\npriority = (\d+)/g)].map((m) => `${m[1]}:${m[2]}:${m[3]}`);
  assert.deepEqual(rules(policyToml({ readonly: true, allowNetwork: false })), [
    'write_file:deny:900', 'replace:deny:900', 'run_shell_command:deny:900', 'web_fetch:deny:950', 'google_web_search:deny:950',
  ]);
  assert.deepEqual(rules(policyToml({ readonly: false, allowNetwork: true })), ['write_file:allow:900', 'replace:allow:900', 'run_shell_command:allow:900']);
  assert.deepEqual(rules(policyToml({ readonly: false, allowNetwork: false })).slice(3), ['web_fetch:deny:950', 'google_web_search:deny:950']);
});

test('gemini parser takes the text after the last tool call, joining deltas, and reports usage and errors', () => {
  const parser = getProvider('gemini').createParser();
  const feed = (event) => parser.onEvent(event);
  assert.deepEqual(feed({ type: 'init', session_id: 's1', model: 'gem' }), { sessionId: 's1' });
  assert.equal(feed({ type: 'message', role: 'user', content: 'hi' }).finalText, undefined);
  assert.equal(feed({ type: 'message', role: 'assistant', content: 'Let me ', delta: true }).finalText, 'Let me ');
  assert.equal(feed({ type: 'message', role: 'assistant', content: 'look.', delta: true }).finalText, 'Let me look.');
  assert.deepEqual(feed({ type: 'tool_use', tool_name: 'read_file', tool_id: 't', parameters: {} }), {});
  assert.equal(feed({ type: 'message', role: 'assistant', content: 'Done', delta: true }).finalText, 'Done');
  assert.equal(feed({ type: 'message', role: 'assistant', content: 'Replaced.' }).finalText, 'Replaced.');
  assert.deepEqual(feed({ type: 'error', severity: 'error', message: 'non-fatal' }), {});
  assert.deepEqual(feed({ type: 'result', status: 'success', stats: { total_tokens: 5 } }), { usage: { total_tokens: 5 } });
  assert.equal(feed({ type: 'result', status: 'error', error: { message: 'x' } }).error, 'x');
  assert.equal(feed({ type: 'result', status: 'error' }).error, true);
});

test('opencode args run standalone with JSON output, a model, and no auto-approve', () => {
  const args = getProvider('opencode').buildArgs({ phase: 'implementer', model: 'anthropic/claude', effort: 'high', readonly: false });
  assert.deepEqual(args, ['run', '--standalone', '--format', 'json', '--archived', '--model', 'anthropic/claude']);
});

test('opencode permissions deny by default, then allow only the phase tools and optional web access', () => {
  const summary = (opts) => opencodePermissions(opts).map((r) => `${r.effect}:${r.action}`);
  assert.deepEqual(summary({ readonly: true, allowNetwork: false }), ['deny:*', 'allow:read', 'allow:glob', 'allow:grep', 'allow:external_directory']);
  assert.deepEqual(summary({ readonly: false, allowNetwork: true }), [
    'deny:*', 'allow:read', 'allow:glob', 'allow:grep', 'allow:edit', 'allow:shell', 'allow:subagent', 'allow:skill', 'allow:external_directory', 'allow:webfetch', 'allow:websearch',
  ]);
  assert.ok(opencodePermissions({ readonly: true }).every((r) => r.resource === '*'));
  const env = getProvider('opencode').extraEnv({ readonly: true, allowNetwork: false });
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
  assert.equal(env.OPENCODE_DISABLE_CLAUDE_CODE, '1');
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT).permissions, opencodePermissions({ readonly: true, allowNetwork: false }));
});

test('opencode parser keeps the last message text built from deltas, plus session, usage and errors', () => {
  const parser = getProvider('opencode').createParser();
  const text = (messageID, value) => ({ type: 'text', sessionID: 'ses_1', part: { messageID, type: 'text', text: value } });
  assert.deepEqual(parser.onEvent(text('m1', 'Thinking ')), { sessionId: 'ses_1', finalText: 'Thinking ' });
  assert.deepEqual(parser.onEvent(text('m1', 'aloud.')), { finalText: 'Thinking aloud.' });
  assert.equal(parser.onEvent(text('m2', 'Final ')).finalText, 'Final ');
  assert.equal(parser.onEvent(text('m2', 'answer.')).finalText, 'Final answer.');
  assert.deepEqual(parser.onEvent({ type: 'step_finish', sessionID: 'ses_1', part: { reason: 'stop', cost: 0.01, tokens: { input: 3, output: 4 } } }), { usage: { tokens: { input: 3, output: 4 }, cost: 0.01 } });
  assert.equal(parser.onEvent({ type: 'error', sessionID: 'ses_1', error: { type: 'x', message: 'y' } }).error, 'y');
  assert.equal(parser.onEvent({ type: 'error', sessionID: 'ses_1', error: { name: 'APIError', data: { message: 'quota' } } }).error, 'quota');
  assert.equal(parser.onEvent({ type: 'error', sessionID: 'ses_1' }).error, true);
});

test('codex parser records turn failures and error events as non-fatal detail', () => {
  const parser = getProvider('codex').createParser();
  assert.deepEqual(parser.onEvent({ type: 'error', message: 'Reconnecting... 1/5' }), { errorDetail: 'Reconnecting... 1/5' });
  assert.deepEqual(parser.onEvent({ type: 'turn.failed', error: { message: 'You hit your spend cap.' } }), { errorDetail: 'You hit your spend cap.' });
});

test('claude parser reports the result text of an error result', () => {
  const parser = getProvider('claude').createParser();
  assert.equal(parser.onEvent({ type: 'result', is_error: true, result: 'Credit balance is too low' }).error, 'Credit balance is too low');
  assert.equal(parser.onEvent({ type: 'result', is_error: true }).error, true);
});

test('provider env allowlists and doctor checks', () => {
  assert.deepEqual(getProvider('gemini').envVars, ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT_ID', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS']);
  assert.ok(getProvider('opencode').envVars.every((v) => v.startsWith('XDG_')));
  assert.deepEqual(getProvider('codex').envVars, ['CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY']);
  for (const name of providerNames()) assert.deepEqual(getProvider(name).doctorChecks()[0].args, ['--version']);
  assert.deepEqual(getProvider('codex').doctorChecks()[1].args, ['login', 'status']);
});
