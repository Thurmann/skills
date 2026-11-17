import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge, parsePrecheck, isLogicFile } from '../src/bridge.js';
import { Store } from '../src/store.js';

function fixture(t, options = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-code-bridge-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const store = new Store(path.join(folder, 'state.sqlite'));
  t.after(() => store.close());
  const repository = { path: folder, base: 'origin/main', baseBranch: 'main', remote: 'origin', github: 'example/app' };
  const config = { teamId: 'T123', allowedUsers: ['U123', 'U456'], allowedChannels: ['C123'], operators: [], runtime: 'codex', repositories: { app: repository }, stateDir: folder, skillPath: '/fixture/skill', allowNetwork: true, maxRepairRounds: 1, models: { codex: { precheck: 'cheap', architect: 'strong', implementer: 'cheap', reviewer: 'strong' } }, allowedModels: { codex: ['strong', 'cheap'] } };
  const calls = [], posts = [], commands = [], published = []; let publications = 0;
  const runner = { async run(request) {
    calls.push(request);
    if (options.run) return options.run(request, calls);
    return { text: request.phase === 'reviewer' ? '{"verdict":"pass","summary":"Verified","findings":[]}' : `${request.phase} evidence`, sessionId: 'fixture-session' };
  } };
  const bridge = new Bridge(config, store, runner, { async post(payload) { posts.push(payload); if (options.post) return options.post(payload); return { ts: '123.99' }; } }, 'UBOT', {
    async prepareTask(c, task) { return { ...task, worktree: folder, branch: 'fix-code/task', guardState: '/fixture/guard.json', gitCommonDir: '/fixture/git', baseCommit: 'base' }; },
    async guardCheck() { return { ok: true }; }, async checkExistingPR() { if (options.closedPR) throw new Error('PR is merged/closed.'); },
    async command(cmd, args) { commands.push(args); if (args[0] === 'rev-parse') return options.startCommit ?? 'start0\n'; return args.includes('--name-only') ? (options.nameOnly ?? 'a.js\nb.js') : '2 files changed'; },
    async publishPR(c, task, result) { publications++; published.push(result); return 'https://github.com/example/app/pull/1'; },
    ...(options.repositoryRouter ? { repositoryRouter: options.repositoryRouter } : {})
  });
  return { folder, store, config, calls, posts, commands, published, bridge, publications: () => publications };
}
function event(text = '<@UBOT> run repo=app -- fix the bug', overrides = {}) {
  return { team_id: 'T123', event_id: 'Ev1', event: { type: 'app_mention', user: 'U123', channel: 'C123', ts: '123.1', text, ...overrides } };
}

test('durable intake deduplicates events and executes strong/cheap/strong with original-thread replies', async t => {
  const f = fixture(t, { run: async request => ({ text: request.phase === 'precheck' ? pre('advanced') : request.phase === 'reviewer' ? '{"verdict":"pass","summary":"Verified","findings":[]}' : `${request.phase} evidence` }) });
  const accepted = await f.bridge.receive(event());
  assert.equal(accepted.accepted, true);
  assert.equal((await f.bridge.receive(event())).accepted, false);
  assert.equal(f.store.listJobs().length, 1);
  await f.bridge.tick();
  assert.deepEqual(f.calls.map(c => c.model), ['cheap', 'strong', 'cheap', 'strong']);
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
  const f = fixture(t, { run: async request => ({ text: request.phase === 'precheck' ? pre('advanced') : request.phase === 'reviewer' ? JSON.stringify({ verdict: ++reviews === 1 ? 'changes_requested' : 'pass', summary: 'review', findings: reviews === 1 ? ['add regression'] : [] }) : 'evidence' }) });
  await f.bridge.receive(event()); await f.bridge.tick();
  assert.deepEqual(f.calls.map(c => c.phase), ['precheck', 'architect', 'implementer', 'reviewer', 'implementer', 'reviewer']);
  assert.equal(f.publications(), 1);
});

const pre = (mode, extra = {}) => JSON.stringify({ mode, reason: 'because', predicted_files: 2, predicted_areas: ['src'], risk_flags: [], confidence: 'high', ...extra });
const modeRun = (precheck, impl = 'done') => async request => ({ text: request.phase === 'precheck' ? precheck : request.phase === 'reviewer' ? '{"verdict":"pass","summary":"ok","findings":[]}' : impl });
const phases = f => f.calls.map(c => c.phase);

test('simple mode skips architect and reviewer and publishes with the outcome stated', async t => {
  const f = fixture(t, { run: modeRun(pre('simple')) });
  await f.bridge.receive(event()); await f.bridge.tick();
  assert.deepEqual(phases(f), ['precheck', 'implementer']);
  assert.equal(f.publications(), 1);
  const job = f.store.listJobs()[0];
  assert.equal(job.mode, 'simple'); assert.equal(f.store.listTasks()[0].mode, 'simple');
  assert.match(f.calls[1].prompt, /Execution mode: simple/);
  assert.match(f.calls[1].prompt, /SCOPE_EXCEEDED/);
  assert.match(f.store.listOutbox().at(-1).text, /Independent review: not required/);
});

test('simple escalates to medium on SCOPE_EXCEEDED and then runs the reviewer', async t => {
  const f = fixture(t, { run: modeRun(pre('simple'), 'done\nSCOPE_EXCEEDED: touched auth') });
  await f.bridge.receive(event()); await f.bridge.tick();
  assert.deepEqual(phases(f), ['precheck', 'implementer', 'reviewer']);
  const job = f.store.listJobs()[0];
  assert.equal(job.mode, 'medium'); assert.equal(job.escalation.from, 'simple');
  assert.equal(f.publications(), 1);
  assert.match(f.store.listOutbox().at(-1).text, /Independent review: passed/);
});

test('simple escalates when more than three files change', async t => {
  const f = fixture(t, { run: modeRun(pre('simple')), nameOnly: 'a\nb\nc\nd' });
  await f.bridge.receive(event()); await f.bridge.tick();
  assert.deepEqual(phases(f), ['precheck', 'implementer', 'reviewer']);
});

test('medium within prediction skips review; exceeding the prediction requires it', async t => {
  const f = fixture(t, { run: modeRun(pre('medium', { predicted_files: 4 })), nameOnly: 'a\nb\nc\nd' });
  await f.bridge.receive(event()); await f.bridge.tick();
  assert.deepEqual(phases(f), ['precheck', 'implementer']);
  assert.equal(f.publications(), 1);
  const g = fixture(t, { run: modeRun(pre('medium', { predicted_files: 2 })), nameOnly: 'a\nb\nc\nd\ne' });
  await g.bridge.receive(event()); await g.bridge.tick();
  assert.deepEqual(phases(g), ['precheck', 'implementer', 'reviewer']);
  assert.equal(g.publications(), 1);
});

test('explicit mode= skips precheck; followup never auto-downgrades but explicit mode can lower', async t => {
  const f = fixture(t, { run: modeRun(pre('simple')) });
  await f.bridge.receive(event('<@UBOT> run repo=app mode=advanced -- big change')); await f.bridge.tick();
  assert.deepEqual(phases(f), ['architect', 'implementer', 'reviewer']);
  assert.equal(f.store.listTasks()[0].mode, 'advanced');
  f.calls.length = 0;
  await f.bridge.receive({ ...event('<@UBOT> followup -- tweak', { thread_ts: '123.1', ts: '123.2' }), event_id: 'Ev2' }); await f.bridge.tick();
  assert.deepEqual(phases(f), ['precheck', 'architect', 'implementer', 'reviewer']);
  f.calls.length = 0;
  await f.bridge.receive({ ...event('<@UBOT> followup mode=simple -- tiny', { thread_ts: '123.1', ts: '123.3' }), event_id: 'Ev3' }); await f.bridge.tick();
  assert.deepEqual(phases(f), ['implementer']);
  assert.equal(f.store.getTask(f.store.listTasks()[0].id).mode, 'simple');
});

test('in-prediction medium with SCOPE_EXCEEDED is reviewed', async t => {
  const f = fixture(t, { run: modeRun(pre('medium', { predicted_files: 4 }), 'done\nSCOPE_EXCEEDED: extra area'), nameOnly: 'a\nb' });
  await f.bridge.receive(event()); await f.bridge.tick();
  assert.deepEqual(phases(f), ['precheck', 'implementer', 'reviewer']);
});

test('explicit mode=medium always runs independent review', async t => {
  const f = fixture(t, { run: modeRun(pre('simple')) });
  await f.bridge.receive(event('<@UBOT> run repo=app mode=medium -- change')); await f.bridge.tick();
  assert.deepEqual(phases(f), ['implementer', 'reviewer']);
  assert.match(f.store.listOutbox().at(-1).text, /Independent review: passed/);
});

test('published result leads with the outcome even when implementer output is huge', async t => {
  const f = fixture(t, { run: modeRun(pre('simple'), 'x'.repeat(13000)) });
  await f.bridge.receive(event()); await f.bridge.tick();
  assert.equal(f.published.length, 1);
  assert.match(f.published[0].slice(0, 12000), /^Mode: simple\. Independent review: not required/);
});

test('low confidence without a risk flag does not bump the mode through tick', async t => {
  const f = fixture(t, { run: modeRun(pre('simple', { confidence: 'low' })) });
  await f.bridge.receive(event()); await f.bridge.tick();
  assert.equal(f.store.listJobs()[0].mode, 'simple');
  assert.deepEqual(phases(f), ['precheck', 'implementer']);
});

test('low confidence with a risk flag bumps simple past medium rules through tick', async t => {
  const f = fixture(t, { run: modeRun(pre('medium', { confidence: 'low', risk_flags: ['auth'] })) });
  await f.bridge.receive(event()); await f.bridge.tick();
  assert.equal(f.store.listJobs()[0].mode, 'advanced');
  assert.deepEqual(phases(f), ['precheck', 'architect', 'implementer', 'reviewer']);
});

test('logic-file count ignores test, doc and lockfile changes for escalation and review', async t => {
  const names = 'a.js\ntest/a.test.js\nsrc/b.spec.ts\nREADME.md\ndocs/x.png\npackage-lock.json\ntests/helper.js';
  const f = fixture(t, { run: modeRun(pre('simple')), nameOnly: names });
  await f.bridge.receive(event()); await f.bridge.tick();
  assert.deepEqual(phases(f), ['precheck', 'implementer']);
  const g = fixture(t, { run: modeRun(pre('medium', { predicted_files: 2 })), nameOnly: 'a.js\nb.js\n' + names });
  await g.bridge.receive(event()); await g.bridge.tick();
  assert.deepEqual(phases(g), ['precheck', 'implementer']);
});

test('calibration record is saved and written, and the outcome states logic files', async t => {
  const f = fixture(t, { run: modeRun(pre('simple', { predicted_files: 1 })), nameOnly: 'a.js\nREADME.md' });
  await f.bridge.receive(event()); await f.bridge.tick();
  const job = f.store.listJobs()[0];
  const expected = { model_mode: 'simple', mode_after_precheck: 'simple', final_mode: 'simple', predicted_files: 1, changed_files: 2, changed_logic_files: 1, escalated: false, reviewed: false, review_reason: null };
  assert.deepEqual(job.calibration, expected);
  const file = path.join(f.folder, 'artifacts', job.taskId, job.id, 'calibration.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), expected);
  assert.match(f.published[0], /Predicted\/actual logic files: 1\/1\./);
  const g = fixture(t);
  await g.bridge.receive(event('<@UBOT> run repo=app mode=medium -- change')); await g.bridge.tick();
  assert.equal(g.store.listJobs()[0].calibration.model_mode, null);
});

test('prompts read skill files per phase', async t => {
  const f = fixture(t, { run: modeRun(pre('advanced')) });
  await f.bridge.receive(event()); await f.bridge.tick();
  const prompt = phase => f.calls.find(c => c.phase === phase).prompt;
  assert.doesNotMatch(prompt('precheck'), /Use the installed fix-code skill/);
  assert.doesNotMatch(prompt('precheck'), /SKILL\.md/);
  assert.match(prompt('architect'), /references\/modes\.md.*references\/change-types\.md/);
  assert.match(prompt('implementer'), /git-and-pr\.md/);
  assert.match(prompt('reviewer'), /references\/modes\.md/);
  for (const phase of ['architect', 'implementer', 'reviewer']) assert.match(prompt(phase), /Do not read model-policy\.md or integrations\.md/);
  assert.doesNotMatch(prompt('implementer'), /model-policy\.md\)|\/model-policy/);
});

test('change counting uses the job start commit, not the task base', async t => {
  const f = fixture(t, { run: modeRun(pre('simple')), startCommit: 'abc123\n' });
  await f.bridge.receive(event()); await f.bridge.tick();
  const names = f.commands.find(a => a.includes('--name-only'));
  assert.ok(names.includes('abc123..HEAD'));
  assert.equal(f.store.listJobs()[0].startCommit, 'abc123');
});

test('retry keeps the previous explicit mode', async t => {
  let fail = true;
  const f = fixture(t, { run: async request => { if (request.phase === 'implementer' && fail) { fail = false; throw new Error('boom'); } return modeRun(pre('simple'))(request); } });
  await f.bridge.receive(event('<@UBOT> run repo=app mode=medium -- change')); await f.bridge.tick();
  assert.equal(f.store.listJobs()[0].status, 'failed');
  await f.bridge.receive({ ...event('<@UBOT> retry', { thread_ts: '123.1', ts: '123.2' }), event_id: 'Ev2' });
  assert.equal(f.store.listJobs().at(-1).requestedMode, 'medium');
});

test('parsePrecheck normalizes unreadable, risky and invalid predictions', () => {
  const bad = parsePrecheck('nope');
  assert.equal(bad.mode, 'medium'); assert.equal(bad.predicted_files, null); assert.match(bad.reason, /medium with mandatory review/);
  assert.equal(parsePrecheck(pre('simple', { confidence: 'low' })).mode, 'simple');
  assert.equal(parsePrecheck(pre('simple', { confidence: 'bogus' })).confidence, 'medium');
  assert.equal(parsePrecheck(pre('medium', { confidence: 'low' })).mode, 'medium');
  assert.equal(parsePrecheck(pre('simple', { risk_flags: ['auth'] })).mode, 'medium');
  assert.equal(parsePrecheck(pre('simple', { confidence: 'low', risk_flags: ['auth'] })).mode, 'medium');
  assert.equal(parsePrecheck(pre('medium', { confidence: 'low', risk_flags: ['data'] })).mode, 'advanced');
  assert.equal(parsePrecheck(pre('advanced')).mode, 'advanced');
  assert.equal(parsePrecheck('```json\n' + pre('simple') + '\n```').mode, 'simple');
  assert.equal(parsePrecheck(pre('simple', { predicted_files: 0 })).predicted_files, null);
  assert.equal(parsePrecheck(pre('simple', { predicted_files: 1.5 })).predicted_files, null);
  assert.equal(parsePrecheck(pre('bogus')).mode, 'medium');
});

test('two distinct risk categories make advanced; duplicates in one category do not', () => {
  const two = parsePrecheck(pre('medium', { risk_flags: ['security', 'concurrency'] }));
  assert.equal(two.mode, 'advanced'); assert.deepEqual(two.risk_flags, ['security', 'concurrency']); assert.equal(two.model_mode, 'medium');
  const one = parsePrecheck(pre('medium', { risk_flags: ['data', 'migration', 'data migration'] }));
  assert.equal(one.mode, 'medium'); assert.deepEqual(one.risk_flags, ['data/migration']);
});

test('non-risk flags move to notes and do not affect the mode', () => {
  const r = parsePrecheck(pre('simple', { risk_flags: ['public API', 'build/deploy'], notes: 'touches CLI' }));
  assert.equal(r.mode, 'simple'); assert.deepEqual(r.risk_flags, []); assert.deepEqual(r.notes, ['touches CLI', 'public API', 'build/deploy']);
  assert.deepEqual(parsePrecheck(pre('simple', { notes: ['a', 'b'] })).notes, ['a', 'b']);
});

test('isLogicFile excludes tests, docs and lockfiles but keeps source', () => {
  for (const f of ['test/a.js', 'src/__tests__/a.js', 'a.test.ts', 'a.spec.mjs', 'tests/test_a.py', 'test_a.py', 'a_test.go', 'README.md', 'notes.txt', 'docs/a.html', 'package-lock.json', 'sub/yarn.lock', 'go.sum']) assert.equal(isLogicFile(f), false, f);
  for (const f of ['src/bridge.js', 'a.py', 'main.go', 'src/contest/a.js', 'Makefile']) assert.equal(isLogicFile(f), true, f);
});

test('unreadable precheck falls back to medium with review and no architect in the pipeline', async t => {
  const f = fixture(t);
  await f.bridge.receive(event()); await f.bridge.tick();
  assert.equal(f.store.listJobs()[0].mode, 'medium');
  assert.deepEqual(phases(f), ['precheck', 'implementer', 'reviewer']);
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
