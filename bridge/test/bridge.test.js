import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';

function fixture(t, options = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-code-bridge-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const store = new Store(path.join(folder, 'state.sqlite'));
  t.after(() => store.close());
  const repository = { path: folder, base: 'origin/main', baseBranch: 'main', remote: 'origin', github: 'example/app' };
  const config = { teamId: 'T123', allowedUsers: ['U123', 'U456'], allowedChannels: ['C123'], operators: [], runtime: 'codex', repositories: { app: repository }, stateDir: folder, skillPath: '/fixture/skill', allowNetwork: true, maxRepairRounds: 1, models: { codex: { architect: 'strong', implementer: 'cheap', reviewer: 'strong' } }, allowedModels: { codex: ['strong', 'cheap'] } };
  const calls = [], posts = []; let publications = 0;
  const runner = { async run(request) {
    calls.push(request);
    if (options.run) return options.run(request, calls);
    return { text: request.phase === 'reviewer' ? '{"verdict":"pass","summary":"Verified","findings":[]}' : `${request.phase} evidence`, sessionId: 'fixture-session' };
  } };
  const bridge = new Bridge(config, store, runner, { async post(payload) { posts.push(payload); if (options.post) return options.post(payload); return { ts: '123.99' }; } }, 'UBOT', {
    async prepareTask(c, task) { return { ...task, worktree: folder, branch: 'fix-code/task', guardState: '/fixture/guard.json', gitCommonDir: '/fixture/git', baseCommit: 'base' }; },
    async guardCheck() { return { ok: true }; }, async checkExistingPR() { if (options.closedPR) throw new Error('PR is merged/closed.'); },
    async command() { return '2 files changed'; },
    async publishPR() { publications++; return 'https://github.com/example/app/pull/1'; },
    ...(options.repositoryRouter ? { repositoryRouter: options.repositoryRouter } : {})
  });
  return { folder, store, config, calls, posts, bridge, publications: () => publications };
}
function event(text = '<@UBOT> run repo=app -- fix the bug', overrides = {}) {
  return { team_id: 'T123', event_id: 'Ev1', event: { type: 'app_mention', user: 'U123', channel: 'C123', ts: '123.1', text, ...overrides } };
}

test('durable intake deduplicates events and executes strong/cheap/strong with original-thread replies', async t => {
  const f = fixture(t);
  const accepted = await f.bridge.receive(event());
  assert.equal(accepted.accepted, true);
  assert.equal((await f.bridge.receive(event())).accepted, false);
  assert.equal(f.store.listJobs().length, 1);
  await f.bridge.tick();
  assert.deepEqual(f.calls.map(c => c.model), ['strong', 'cheap', 'strong']);
  assert.equal(f.publications(), 1);
  assert.equal(f.store.getTask(accepted.taskId).status, 'succeeded');
  assert.match(f.calls[1].prompt, /Do not push or create a PR yourself/);
  await f.bridge.flushOutbox();
  assert.ok(f.posts.length >= 4);
  assert.ok(f.posts.every(p => p.channel === 'C123' && p.thread_ts === '123.1'));
  assert.ok(f.posts.every(p => !p.text.includes('<@')));
});

test('unauthorized/bot/cross-workspace/Slack Connect reports cause no job or response', async t => {
  const f = fixture(t);
  for (const body of [event(undefined, { user: 'UOTHER' }), event(undefined, { bot_id: 'B123' }), { ...event(), team_id: 'TOTHER' }, { ...event(), is_ext_shared_channel: true }]) await f.bridge.receive(body);
  assert.equal(f.store.listJobs().length, 0);
  assert.equal(f.store.listOutbox().length, 0);
});

test('wildcard accepts distinct valid channels while retaining workspace, user, ID, and shared-channel restrictions', async t => {
  const f = fixture(t);
  f.config.allowedChannels = ['*'];
  assert.equal((await f.bridge.receive(event('<@UBOT> run repo=app -- fix the bug', { channel: 'C123' }))).accepted, true);
  assert.equal((await f.bridge.receive({ ...event('<@UBOT> run repo=app -- fix another bug', { channel: 'G456', ts: '124.1' }), event_id: 'Ev2' })).accepted, true);
  for (const body of [
    { ...event(undefined, { channel: 'D789', ts: '125.1' }), event_id: 'Ev3' },
    { ...event(undefined, { channel: '', ts: '126.1' }), event_id: 'Ev4' },
    { ...event(undefined, { channel: 'C789', user: 'UOTHER', ts: '127.1' }), event_id: 'Ev5' },
    { ...event(undefined, { channel: 'C789', ts: '128.1' }), team_id: 'TOTHER', event_id: 'Ev6' },
    { ...event(undefined, { channel: 'C789', ts: '129.1', is_ext_shared_channel: true }), event_id: 'Ev7' }
  ]) assert.equal((await f.bridge.receive(body)).accepted, false);
  assert.equal(f.store.listJobs().length, 2);
});

test('explicit channel lists continue to restrict intake', async t => {
  const f = fixture(t);
  f.config.allowedChannels = ['C123'];
  assert.equal((await f.bridge.receive(event())).accepted, true);
  assert.equal((await f.bridge.receive({ ...event('<@UBOT> run repo=app -- another', { channel: 'C456', ts: '124.1' }), event_id: 'Ev2' })).accepted, false);
  assert.equal(f.store.listJobs().length, 1);
});

test('another allowlisted user cannot control the owner’s task', async t => {
  const f = fixture(t);
  await f.bridge.receive(event());
  await f.bridge.receive({ ...event('<@UBOT> cancel', { user: 'U456', thread_ts: '123.1', ts: '123.2' }), event_id: 'Ev2' });
  assert.equal(f.store.nextJob().status, 'queued');
  assert.match(f.store.listOutbox().at(-1).text, /Only this task/);
});

test('followups stay on one task/branch and queued cancellation is durable', async t => {
  const f = fixture(t);
  const first = await f.bridge.receive(event());
  await f.bridge.receive({ ...event('<@UBOT> followup implementer_model=strong -- also cover retry', { thread_ts: '123.1', ts: '123.2' }), event_id: 'Ev2' });
  assert.equal(f.store.listTasks().length, 1);
  assert.equal(f.store.listJobs().length, 2);
  assert.equal(f.store.listJobs()[1].models.implementer, 'strong');
  await f.bridge.receive({ ...event('<@UBOT> cancel', { thread_ts: '123.1', ts: '123.3' }), event_id: 'Ev3' });
  assert.ok(f.store.jobsForTask(first.taskId).every(job => job.status === 'canceled'));
  await f.bridge.tick(); assert.equal(f.calls.length, 0);
});

test('model overrides in request body are inert; header overrides must be allowlisted', async t => {
  const f = fixture(t);
  await f.bridge.receive(event('<@UBOT> run repo=app -- code example model=untrusted $(touch /tmp/no)'));
  assert.equal(f.store.nextJob().models.implementer, 'cheap');
  await f.bridge.receive({ ...event('<@UBOT> run repo=app model=untrusted -- fix', { ts: '124.1' }), event_id: 'Ev2' });
  assert.equal(f.store.listJobs().length, 1);
});

test('failed or contradictory review never publishes', async t => {
  for (const verdict of [JSON.stringify({ verdict: 'blocked', summary: 'No reproduction evidence', findings: [] }), 'not JSON', JSON.stringify({ verdict: 'pass', summary: 'But bug remains', findings: ['bug'] })]) {
    const f = fixture(t, { run: async request => ({ text: request.phase === 'reviewer' ? verdict : 'done' }) });
    await f.bridge.receive(event()); await f.bridge.tick();
    assert.equal(f.publications(), 0);
    assert.equal(f.store.listTasks()[0].status, 'failed');
  }
});

test('repair loop is bounded and uses cheap model before a fresh review', async t => {
  let reviews = 0;
  const f = fixture(t, { run: async request => ({ text: request.phase === 'reviewer' ? JSON.stringify({ verdict: ++reviews === 1 ? 'changes_requested' : 'pass', summary: 'review', findings: reviews === 1 ? ['add regression'] : [] }) : 'evidence' }) });
  await f.bridge.receive(event()); await f.bridge.tick();
  assert.deepEqual(f.calls.map(c => c.phase), ['architect', 'implementer', 'reviewer', 'implementer', 'reviewer']);
  assert.equal(f.publications(), 1);
});

test('cancellation aborts active run and never publishes', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = fixture(t, { run: request => new Promise((resolve, reject) => { started(); request.signal.addEventListener('abort', () => reject(new Error('Canceled')), { once: true }); }) });
  await f.bridge.receive(event());
  const running = f.bridge.tick(); await ready;
  await f.bridge.receive({ ...event('<@UBOT> cancel', { thread_ts: '123.1', ts: '123.2' }), event_id: 'Ev2' });
  await running;
  assert.equal(f.store.listTasks()[0].status, 'canceled');
  assert.equal(f.publications(), 0);
});

test('restart marks interrupted runs and ambiguous replies without automatic retries', async t => {
  const f = fixture(t);
  const first = await f.bridge.receive(event());
  const job = f.store.nextJob(); job.status = 'running'; job.pid = null; f.store.saveJob(job);
  const entry = f.store.listOutbox()[0]; entry.status = 'sending'; f.store.saveOutbox(entry);
  f.bridge.recover();
  assert.equal(f.store.getTask(first.taskId).status, 'interrupted');
  assert.equal(f.store.getJob(job.id).status, 'interrupted');
  assert.equal(f.store.getOutbox(entry.id).status, 'uncertain');
  assert.equal(f.store.nextJob(), null);
  await f.bridge.receive({ ...event('<@UBOT> retry', { thread_ts: '123.1', ts: '123.2' }), event_id: 'Ev2' });
  assert.equal(f.store.nextJob().taskId, first.taskId);
});

test('closed PR blocks followup before model calls', async t => {
  const f = fixture(t, { closedPR: true });
  await f.bridge.receive(event()); await f.bridge.tick();
  assert.equal(f.calls.length, 0); assert.equal(f.publications(), 0);
});

test('network reply failure is uncertain and is not automatically sent twice', async t => {
  const f = fixture(t, { post: async () => { throw new Error('connection lost'); } });
  await f.bridge.receive(event()); await f.bridge.flushOutbox(); await f.bridge.flushOutbox();
  assert.equal(f.posts.length, 1);
  assert.equal(f.store.listOutbox()[0].status, 'uncertain');
});

test('status and cancel on an empty thread do not crash', async t => {
  const f = fixture(t);
  await f.bridge.receive(event('<@UBOT> status'));
  await f.bridge.receive({ ...event('<@UBOT> cancel'), event_id: 'Ev2' });
  assert.equal(f.store.listJobs().length, 0);
  assert.equal(f.store.listOutbox().length, 2);
});

function channelMode(f) {
  f.config.repositoryRouting = { mode: 'channel', cloneRoot: path.join(f.folder, 'repositories'), allowedOwners: [], channelOwners: {} };
  f.config.repositories = {};
}
function channelRepository(folder) {
  return { path: path.join(folder, 'repositories', '123'), base: 'origin/main', baseBranch: 'main', remote: 'origin', github: 'example/billing-service', githubId: 123 };
}

test('channel lookup happens after durable intake; thread context remains pinned across rename and followup', async t => {
  let lookups = 0, prepares = 0, changedName = false;
  let f;
  const router = {
    async resolve() { lookups++; return { channelName: changedName ? 'other-repo' : 'billing-service', repository: channelRepository(f.folder) }; },
    async prepare(task) { prepares++; assert.equal(f.store.getTask(task.id).repository.githubId, 123, 'binding must be durable before clone'); return task.repository; }
  };
  f = fixture(t, { repositoryRouter: router }); channelMode(f);
  const accepted = await f.bridge.receive(event('<@UBOT> run -- fix the retry bug'));
  assert.equal(accepted.accepted, true);
  assert.equal(lookups, 0);
  assert.equal(f.store.listJobs().length, 1);
  assert.equal(f.store.getTask(accepted.taskId).repository, null);
  await f.bridge.tick();
  assert.equal(lookups, 1); assert.equal(prepares, 1);
  assert.equal(f.store.getTask(accepted.taskId).repository.github, 'example/billing-service');
  assert.match(f.calls[0].prompt, /Slack #billing-service → example\/billing-service/);
  changedName = true;
  await f.bridge.receive({ ...event('<@UBOT> followup -- also test an empty response', { thread_ts: '123.1', ts: '123.2' }), event_id: 'Ev2' });
  await f.bridge.tick();
  assert.equal(lookups, 1, 'a bound thread must not resolve a renamed channel again');
  assert.equal(prepares, 2);
  assert.equal(f.store.getTask(accepted.taskId).channelName, 'billing-service');
});

test('channel mode rejects repo= overrides and does not start unrequested repository work', async t => {
  const f = fixture(t); channelMode(f);
  await f.bridge.receive(event('<@UBOT> run repo=other -- change another repo'));
  assert.equal(f.store.listJobs().length, 0);
  assert.match(f.store.listOutbox()[0].text, /Remove repo=/);
});

test('lookup failure blocks before coding; retry preserves a saved binding after a clone failure', async t => {
  let f, resolves = 0, prepares = 0;
  f = fixture(t, { repositoryRouter: {
    async resolve() { resolves++; return { channelName: 'billing-service', repository: channelRepository(f.folder) }; },
    async prepare(task) { if (++prepares === 1) throw new Error('Clone temporarily unavailable'); return task.repository; }
  } }); channelMode(f);
  const accepted = await f.bridge.receive(event('<@UBOT> run -- fix bug'));
  await f.bridge.tick();
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.getTask(accepted.taskId).status, 'failed');
  assert.equal(f.store.getTask(accepted.taskId).repository.githubId, 123);
  await f.bridge.receive({ ...event('<@UBOT> retry', { thread_ts: '123.1', ts: '123.2' }), event_id: 'Ev2' });
  await f.bridge.tick();
  assert.equal(resolves, 1);
  assert.equal(f.store.getTask(accepted.taskId).status, 'succeeded');
  const broken = fixture(t, { repositoryRouter: { async resolve() { throw new Error('No unique match'); }, async prepare() { assert.fail('No clone before resolution'); } } }); channelMode(broken);
  await broken.bridge.receive(event('<@UBOT> run -- fix bug')); await broken.bridge.tick();
  assert.equal(broken.calls.length, 0); assert.equal(broken.publications(), 0);
});

test('cancellation during channel lookup prevents clone and model calls', async t => {
  let f, notify;
  const started = new Promise(resolve => { notify = resolve; });
  f = fixture(t, { repositoryRouter: {
    async resolve(task, signal) {
      notify();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return { channelName: 'billing-service', repository: channelRepository(f.folder) };
    },
    async prepare() { assert.fail('Canceled task must not clone'); }
  } }); channelMode(f);
  await f.bridge.receive(event('<@UBOT> run -- fix bug'));
  const running = f.bridge.tick(); await started;
  await f.bridge.receive({ ...event('<@UBOT> cancel', { thread_ts: '123.1', ts: '123.2' }), event_id: 'Ev2' });
  await running;
  assert.equal(f.store.listTasks()[0].status, 'canceled');
  assert.equal(f.store.listTasks()[0].repository, null);
  assert.equal(f.calls.length, 0);
});
