import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRunner } from '../src/runner.js';

const testRoot = await mkdtemp(path.join(os.tmpdir(), 'fix-code-runner-tests-'));

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

async function makeExecutable(name, body) {
  const filename = path.join(testRoot, `${name}-${Math.random().toString(16).slice(2)}.mjs`);
  await writeFile(filename, `#!/usr/bin/env node\n${body}\n`, { mode: 0o700 });
  await chmod(filename, 0o700);
  return filename;
}

async function makeCwd(name = 'workspace') {
  const cwd = path.join(testRoot, `${name}-${Math.random().toString(16).slice(2)}`);
  await import('node:fs/promises').then(({ mkdir }) => mkdir(cwd, { recursive: true }));
  return cwd;
}

function codexEvent(type, extra = {}) {
  return JSON.stringify({ type, ...extra }) + '\n';
}

test('Codex receives literal prompt on stdin and returns thread text and usage', async () => {
  const capture = path.join(testRoot, 'codex-capture.json');
  const script = await makeExecutable('codex-success', `
    import { writeFileSync } from 'node:fs';
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, input }));
    process.stdout.write(${JSON.stringify(codexEvent('thread.started', { thread_id: 'thread-123' }))});
    process.stdout.write(${JSON.stringify(codexEvent('item.completed', { item: { type: 'agent_message', text: 'Implementation complete.' } }))});
    process.stdout.write(${JSON.stringify(codexEvent('turn.completed', { usage: { input_tokens: 17, output_tokens: 8 } }))});
  `);
  const cwd = await makeCwd();
  const commonDir = await makeCwd('git-common');
  const prior = { SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN, NODE_OPTIONS: process.env.NODE_OPTIONS, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  process.env.SLACK_BOT_TOKEN = 'slack-secret-value';
  process.env.NODE_OPTIONS = '--require=/tmp/should-not-load.js';
  process.env.OPENAI_API_KEY = 'model-key';
  const literalPrompt = 'literal $(touch /tmp/runner-shell-injection) `not-a-command`';
  const pidEvents = [];
  const sessionEvents = [];
  try {
    const run = createRunner({ codexPath: script, allowNetwork: true, timeoutMs: 5000 });
    const result = await run({
      runtime: 'codex', phase: 'implementer', model: 'gpt-test', effort: 'low', cwd,
      prompt: literalPrompt, gitCommonDir: commonDir,
      onSession: async (id) => sessionEvents.push(id),
      onPid: async (pid) => pidEvents.push(pid ?? null),
    });
    const received = JSON.parse(await readFile(capture, 'utf8'));
    assert.equal(result.text, 'Implementation complete.');
    assert.equal(result.sessionId, 'thread-123');
    assert.deepEqual(result.usage, { input_tokens: 17, output_tokens: 8 });
    assert.deepEqual(sessionEvents, ['thread-123']);
    assert.equal(pidEvents.length, 2);
    assert.ok(Number.isInteger(pidEvents[0]));
    assert.equal(pidEvents[1], null);
    assert.equal(received.input.endsWith(literalPrompt), true);
    assert.equal(received.argv.includes('--add-dir'), true);
    assert.equal(received.argv[received.argv.indexOf('--add-dir') + 1], commonDir);
    assert.equal(received.argv.includes('sandbox_workspace_write.network_access=true'), true);
    assert.equal(received.argv.includes('mcp_servers={}'), true);
    assert.match(received.input, /Network use is authorized only within the limits enforced by the configured runtime/);
    assert.equal(received.env.SLACK_BOT_TOKEN, undefined);
    assert.equal(received.env.NODE_OPTIONS, undefined);
    assert.equal(received.env.OPENAI_API_KEY, 'model-key');
    // Keychain-backed CLI logins (Claude Code on macOS) look up credentials by account name.
    assert.equal(received.env.USER, process.env.USER);
  } finally {
    restoreEnv('SLACK_BOT_TOKEN', prior.SLACK_BOT_TOKEN);
    restoreEnv('NODE_OPTIONS', prior.NODE_OPTIONS);
    restoreEnv('OPENAI_API_KEY', prior.OPENAI_API_KEY);
  }
});

test('read-only Codex phases do not get an added directory or write sandbox', async () => {
  const capture = path.join(testRoot, 'readonly-argv.json');
  const script = await makeExecutable('codex-readonly', `
    import { writeFileSync } from 'node:fs';
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv.slice(2), input }));
    process.stdout.write(${JSON.stringify(codexEvent('thread.started', { thread_id: 'readonly-1' }))});
    process.stdout.write(${JSON.stringify(codexEvent('item.completed', { item: { type: 'agent_message', text: 'Reviewed.' } }))});
  `);
  const cwd = await makeCwd();
  const runner = createRunner({ codexPath: script });
  assert.equal(runner.run, runner);
  await runner.run({ runtime: 'codex', phase: 'reviewer', model: 'strong', cwd, gitCommonDir: await makeCwd('unused'), prompt: 'Review safely.' });
  const { argv, input } = JSON.parse(await readFile(capture, 'utf8'));
  assert.equal(argv[argv.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(argv.includes('--add-dir'), false);
  assert.equal(argv.includes('sandbox_workspace_write.network_access=false'), true);
  assert.match(input, /Bash for read-only inspection or tests only/);
  assert.match(input, /Network use is not authorized by configuration/);
});

test('Claude stream-json extracts init session, result text, and usage with normal tool permissions', async () => {
  const capture = path.join(testRoot, 'claude-argv.json');
  const script = await makeExecutable('claude-success', `
    import { writeFileSync } from 'node:fs';
    for await (const _chunk of process.stdin) {}
    writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-9' }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'result', result: 'Claude answer', usage: { input_tokens: 3, output_tokens: 4 } }) + '\\n');
  `);
  const cwd = await makeCwd();
  const result = await createRunner({ claudePath: script })({
    runtime: 'claude', phase: 'architect', model: 'opus', cwd, prompt: 'Plan.',
  });
  const argv = JSON.parse(await readFile(capture, 'utf8'));
  assert.equal(result.text, 'Claude answer');
  assert.equal(result.sessionId, 'claude-9');
  assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 4 });
  assert.equal(argv.includes('--strict-mcp-config'), true);
  assert.equal(argv[argv.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(argv.includes('Bash'), false);
  const toolsIndex = argv.indexOf('--tools');
  assert.deepEqual(argv.slice(toolsIndex + 1, toolsIndex + 4), ['Read', 'Glob', 'Grep']);
});

test('precheck phase is accepted and gets read-only Claude tools in plan mode', async () => {
  const capture = path.join(testRoot, 'precheck-argv.json');
  const script = await makeExecutable('claude-precheck', `
    import { writeFileSync } from 'node:fs';
    for await (const _chunk of process.stdin) {}
    writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({ type: 'result', result: 'simple' }) + '\\n');
  `);
  const cwd = await makeCwd();
  const result = await createRunner({ claudePath: script })({ runtime: 'claude', phase: 'precheck', model: 'haiku', cwd, prompt: 'Classify.' });
  const argv = JSON.parse(await readFile(capture, 'utf8'));
  assert.equal(result.text, 'simple');
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'plan');
  const toolsIndex = argv.indexOf('--tools');
  assert.deepEqual(argv.slice(toolsIndex + 1, toolsIndex + 4), ['Read', 'Glob', 'Grep']);
  assert.equal(argv.includes('Bash'), false);
  assert.equal(argv.includes('Edit'), false);
});

test('nonzero exit includes a redacted stderr tail', async () => {
  const script = await makeExecutable('codex-failure', `
    process.stderr.write('private-provider-detail API_KEY=do-not-leak\\n');
    process.exitCode = 7;
    for await (const _chunk of process.stdin) {}
  `);
  const cwd = await makeCwd();
  await assert.rejects(
    createRunner({ codexPath: script })({ runtime: 'codex', phase: 'implementer', model: 'm', cwd, prompt: 'Run.' }),
    (error) => error.message === 'codex runner failed with exit code 7: private-provider-detail API_KEY=[redacted]',
  );
});

test('codex turn failure message is reported instead of stderr when it exits nonzero', async () => {
  const script = await makeExecutable('codex-spend-cap', `
    for await (const _chunk of process.stdin) {}
    process.stdout.write(${JSON.stringify(codexEvent('thread.started', { thread_id: 't' }))});
    process.stdout.write(${JSON.stringify(codexEvent('error', { message: 'Reconnecting... 1/5' }))});
    process.stdout.write(${JSON.stringify(codexEvent('turn.failed', { error: { message: 'You hit your spend cap set by the owner of your workspace.' } }))});
    process.stderr.write('stderr noise\\n');
    process.exitCode = 1;
  `);
  await assert.rejects(
    createRunner({ codexPath: script, timeoutMs: 5000 })({ runtime: 'codex', phase: 'precheck', model: 'm', cwd: await makeCwd(), prompt: 'x' }),
    (error) => error.code === 'NONZERO_EXIT' && error.message === 'codex runner failed with exit code 1: You hit your spend cap set by the owner of your workspace.',
  );
});

test('empty response includes stderr detail', async () => {
  const script = await makeExecutable('codex-empty', `
    for await (const _chunk of process.stdin) {}
    process.stderr.write('Error: model "m" is not supported\\n');
  `);
  await assert.rejects(
    createRunner({ codexPath: script, timeoutMs: 5000 })({ runtime: 'codex', phase: 'precheck', model: 'm', cwd: await makeCwd(), prompt: 'x' }),
    (error) => error.code === 'EMPTY_RESPONSE' && error.message.endsWith(': Error: model "m" is not supported'),
  );
});

test('early CLI exit while stdin is open returns a safe exit error without an unhandled EPIPE', async () => {
  const script = await makeExecutable('codex-early-exit', 'process.exit(9);');
  const cwd = await makeCwd();
  await assert.rejects(
    createRunner({ codexPath: script, timeoutMs: 5000 }).run({
      runtime: 'codex', phase: 'implementer', model: 'm', cwd, prompt: 'x'.repeat(2 * 1024 * 1024),
    }),
    (error) => error.code === 'NONZERO_EXIT' && error.message === 'codex runner failed with exit code 9',
  );
});

test('timeout terminates a hung process group and clears persisted pid', async () => {
  const script = await makeExecutable('codex-hang', `
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    for await (const _chunk of process.stdin) {}
  `);
  const cwd = await makeCwd();
  const pidEvents = [];
  await assert.rejects(
    createRunner({ codexPath: script, timeoutMs: 120 })({
      runtime: 'codex', phase: 'implementer', model: 'm', cwd, prompt: 'Wait.',
      onPid: async (pid) => pidEvents.push(pid ?? null),
    }),
    (error) => error.message === 'codex runner timed out after 120 ms',
  );
  assert.equal(pidEvents.length, 2);
  assert.equal(pidEvents[1], null);
});

test('AbortSignal cancellation terminates the child and rejects as AbortError', async () => {
  const script = await makeExecutable('codex-cancel', `
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    for await (const _chunk of process.stdin) {}
  `);
  const cwd = await makeCwd();
  const controller = new AbortController();
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const running = createRunner({ codexPath: script, timeoutMs: 5000 })({
    runtime: 'codex', phase: 'implementer', model: 'm', cwd, prompt: 'Wait.', signal: controller.signal,
    onPid: async (pid) => { if (pid) started(); },
  });
  await startedPromise;
  controller.abort();
  await assert.rejects(running, (error) => error.name === 'AbortError' && error.message === 'Runner was cancelled');
});

test('cancellation kills a TERM-ignoring descendant before clearing the persisted pid', { skip: process.platform === 'win32' }, async () => {
  const descendantPidPath = path.join(testRoot, `descendant-${Math.random().toString(16).slice(2)}.pid`);
  const script = await makeExecutable('codex-descendant', `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: 'ignore' });
    writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
    process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'with-descendant' }) + '\\n');
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
    for await (const _chunk of process.stdin) {}
  `);
  const cwd = await makeCwd();
  const controller = new AbortController();
  let notifyReady;
  const ready = new Promise((resolve) => { notifyReady = resolve; });
  let descendantPid;
  let clearedAfterDescendantExit = false;
  const running = createRunner({ codexPath: script, timeoutMs: 5000 }).run({
    runtime: 'codex', phase: 'implementer', model: 'm', cwd, prompt: 'Spawn and wait.', signal: controller.signal,
    onSession: async () => {
      descendantPid = Number(await readFile(descendantPidPath, 'utf8'));
      notifyReady();
    },
    onPid: async (pid) => {
      if (pid === null && descendantPid) clearedAfterDescendantExit = !isPidRunning(descendantPid);
    },
  });
  await ready;
  assert.equal(isPidRunning(descendantPid), true);
  controller.abort();
  await assert.rejects(running, (error) => error.name === 'AbortError');
  assert.equal(clearedAfterDescendantExit, true);
  assert.equal(isPidRunning(descendantPid), false);
});

test('oversized output is terminated and rejected', async () => {
  const script = await makeExecutable('codex-large', `
    process.stdout.write('x'.repeat(4096));
    setInterval(() => {}, 1000);
    for await (const _chunk of process.stdin) {}
  `);
  const cwd = await makeCwd();
  await assert.rejects(
    createRunner({ codexPath: script, maxOutputBytes: 1024 })({ runtime: 'codex', phase: 'implementer', model: 'm', cwd, prompt: 'Large output.' }),
    (error) => error.message.includes('exceeded the 1024 byte output limit'),
  );
});

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function isPidRunning(pid) {
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return state.length > 0 && !state.startsWith('Z');
  } catch {
    return false;
  }
}

test('Gemini runs headless with a policy file outside the worktree, stdin prompt, and no Slack tokens', async () => {
  const capture = path.join(testRoot, 'gemini-capture.json');
  const script = await makeExecutable('gemini-success', `
    import { readFileSync, writeFileSync } from 'node:fs';
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const argv = process.argv.slice(2);
    writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv, env: process.env, input, policy: readFileSync(argv[argv.indexOf('--policy') + 1], 'utf8') }));
    const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
    out({ type: 'init', session_id: 'gem-session', model: 'gem' });
    out({ type: 'message', role: 'assistant', content: 'Working', delta: true });
    out({ type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: {} });
    out({ type: 'message', role: 'assistant', content: 'All ', delta: true });
    out({ type: 'message', role: 'assistant', content: 'done.', delta: true });
    out({ type: 'result', status: 'success', stats: { total_tokens: 9 } });
  `);
  const cwd = await makeCwd();
  const outputDir = await makeCwd('gemini-out');
  const prior = { SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN, GEMINI_API_KEY: process.env.GEMINI_API_KEY, MY_EXTRA: process.env.MY_EXTRA };
  process.env.SLACK_BOT_TOKEN = 'slack-secret-value'; process.env.GEMINI_API_KEY = 'gem-key'; process.env.MY_EXTRA = 'extra';
  const sessions = [];
  try {
    const run = createRunner({ skillPath: '/skills/fix-code', runtimes: { gemini: { path: script, env: ['MY_EXTRA'] } }, allowNetwork: false, timeoutMs: 5000 });
    const result = await run({ runtime: 'gemini', phase: 'reviewer', model: 'gem', effort: 'high', cwd, prompt: 'Review $(touch /tmp/x).', outputDir, onSession: async (id) => sessions.push(id) });
    const received = JSON.parse(await readFile(capture, 'utf8'));
    assert.equal(result.text, 'All done.');
    assert.equal(result.sessionId, 'gem-session');
    assert.deepEqual(result.usage, { total_tokens: 9 });
    assert.deepEqual(sessions, ['gem-session']);
    assert.equal(received.input.endsWith('Review $(touch /tmp/x).'), true);
    assert.match(received.input, /file reading and search only/);
    assert.equal(received.argv[received.argv.indexOf('--approval-mode') + 1], 'plan');
    assert.equal(received.argv.some((a) => /yolo|^-y$/.test(a)), false);
    assert.match(received.policy, /toolName = "write_file"\ndecision = "deny"/);
    assert.match(received.policy, /toolName = "web_fetch"\ndecision = "deny"/);
    assert.equal(received.argv[received.argv.indexOf('--policy') + 1].startsWith(outputDir), true);
    assert.deepEqual(received.argv[received.argv.indexOf('--include-directories') + 1].split(','), ['/skills/fix-code', outputDir]);
    assert.equal(received.env.SLACK_BOT_TOKEN, undefined);
    assert.equal(received.env.GEMINI_API_KEY, 'gem-key');
    assert.equal(received.env.MY_EXTRA, 'extra');
    await assert.rejects(run({ runtime: 'gemini', phase: 'reviewer', model: 'gem', cwd, prompt: 'x' }), { code: 'INVALID_OUTPUT_DIR' });
  } finally {
    restoreEnv('SLACK_BOT_TOKEN', prior.SLACK_BOT_TOKEN); restoreEnv('GEMINI_API_KEY', prior.GEMINI_API_KEY); restoreEnv('MY_EXTRA', prior.MY_EXTRA);
  }
});

test('Gemini result errors reject with PROVIDER_ERROR', async () => {
  const script = await makeExecutable('gemini-error', `
    for await (const _chunk of process.stdin) {}
    process.stdout.write(JSON.stringify({ type: 'message', role: 'assistant', content: 'partial' }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'result', status: 'error', error: { message: 'bad' } }) + '\\n');
  `);
  const run = createRunner({ runtimes: { gemini: { path: script } }, timeoutMs: 5000 });
  await assert.rejects(run({ runtime: 'gemini', phase: 'implementer', model: 'gem', cwd: await makeCwd(), outputDir: await makeCwd('gem-err'), prompt: 'x' }), { code: 'PROVIDER_ERROR', message: 'gemini runner reported an error: bad' });
});

test('opencode receives the prompt on stdin with permissions in env and returns the last message text', async () => {
  const capture = path.join(testRoot, 'opencode-capture.json');
  const script = await makeExecutable('opencode-success', `
    import { writeFileSync } from 'node:fs';
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, input }));
    const out = (event) => process.stdout.write(JSON.stringify({ sessionID: 'ses_9', timestamp: 1, ...event }) + '\\n');
    out({ type: 'text', part: { messageID: 'm1', type: 'text', text: 'First.' } });
    out({ type: 'text', part: { messageID: 'm2', type: 'text', text: 'Final ' } });
    out({ type: 'text', part: { messageID: 'm2', type: 'text', text: 'answer.' } });
    out({ type: 'step_finish', part: { reason: 'stop', cost: 0, tokens: { input: 1, output: 2 } } });
  `);
  const cwd = await makeCwd();
  const prior = { SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
  process.env.SLACK_APP_TOKEN = 'slack-app-secret'; process.env.XDG_DATA_HOME = '/data';
  try {
    const run = createRunner({ runtimes: { opencode: { path: script } }, allowNetwork: false, timeoutMs: 5000 });
    const result = await run({ runtime: 'opencode', phase: 'implementer', model: 'anthropic/claude', cwd, prompt: 'Do it.' });
    const received = JSON.parse(await readFile(capture, 'utf8'));
    assert.equal(result.text, 'Final answer.');
    assert.equal(result.sessionId, 'ses_9');
    assert.deepEqual(result.usage, { tokens: { input: 1, output: 2 }, cost: 0 });
    assert.deepEqual(received.argv, ['run', '--standalone', '--format', 'json', '--archived', '--model', 'anthropic/claude']);
    assert.equal(received.input.endsWith('Do it.'), true);
    assert.equal(received.env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
    const rules = JSON.parse(received.env.OPENCODE_CONFIG_CONTENT).permissions;
    assert.deepEqual(rules[0], { action: '*', resource: '*', effect: 'deny' });
    assert.ok(rules.some((r) => r.action === 'edit' && r.effect === 'allow'));
    assert.equal(rules.some((r) => r.action === 'webfetch'), false);
    assert.equal(received.env.SLACK_APP_TOKEN, undefined);
    assert.equal(received.env.XDG_DATA_HOME, '/data');
  } finally {
    restoreEnv('SLACK_APP_TOKEN', prior.SLACK_APP_TOKEN); restoreEnv('XDG_DATA_HOME', prior.XDG_DATA_HOME);
  }
});

test('opencode error events reject with PROVIDER_ERROR and unknown runtimes are rejected', async () => {
  const script = await makeExecutable('opencode-error', `
    for await (const _chunk of process.stdin) {}
    process.stdout.write(JSON.stringify({ type: 'error', sessionID: 's', error: { type: 'x', message: 'y' } }) + '\\n');
    process.exit(1);
  `);
  const run = createRunner({ runtimes: { opencode: { path: script } }, timeoutMs: 5000 });
  await assert.rejects(run({ runtime: 'opencode', phase: 'reviewer', model: 'm', cwd: await makeCwd(), prompt: 'x' }), { code: 'PROVIDER_ERROR' });
  await assert.rejects(run({ runtime: 'nope', phase: 'reviewer', model: 'm', cwd: await makeCwd(), prompt: 'x' }), { code: 'INVALID_RUNTIME' });
});
