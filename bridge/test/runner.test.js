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

test('nonzero exit returns a useful status without exposing stderr', async () => {
  const script = await makeExecutable('codex-failure', `
    process.stderr.write('private-provider-detail API_KEY=do-not-leak\\n');
    process.exitCode = 7;
    for await (const _chunk of process.stdin) {}
  `);
  const cwd = await makeCwd();
  await assert.rejects(
    createRunner({ codexPath: script })({ runtime: 'codex', phase: 'implementer', model: 'm', cwd, prompt: 'Run.' }),
    (error) => error.message === 'codex runner failed with exit code 7' && !error.message.includes('do-not-leak'),
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
