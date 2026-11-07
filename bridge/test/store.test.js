import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../src/store.js';

function database(t) {
  const dir = mkdtempSync(join(tmpdir(), 'slack-bridge-store-'));
  const path = join(dir, 'state.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, path };
}

test('persists records across close and reopen, with private database permissions', (t) => {
  const { path } = database(t);
  let store = new Store(path);
  store.saveTask({ id: 't1', status: 'running', nested: { value: 3 } });
  store.saveJob({ id: 'j1', taskId: 't1', status: 'queued', request: 'build', created: 10 });
  store.saveOutbox({ id: 'o1', status: 'pending', channel: 'C1', threadTs: '1.2', text: 'hello', attempts: 0, nextAttemptAt: 0, created: 11 });
  store.close();

  assert.equal(statSync(path).mode & 0o777, 0o600);
  store = new Store(path);
  assert.deepEqual(store.getTask('t1'), { id: 't1', status: 'running', nested: { value: 3 } });
  assert.equal(store.getJob('j1').request, 'build');
  assert.equal(store.getOutbox('o1').threadTs, '1.2');
  assert.deepEqual(store.listTasks().map((task) => task.id), ['t1']);
  store.close();
});

test('accept atomically records event and related rows, and ignores duplicate events', (t) => {
  const { path } = database(t);
  const store = new Store(path);
  t.after(() => store.close());
  const payload = {
    eventId: 'ev1',
    task: { id: 't1', status: 'queued' },
    job: { id: 'j1', taskId: 't1', status: 'queued', created: 20 },
    outbox: [
      { id: 'o1', status: 'pending', text: 'one', nextAttemptAt: 0, created: 21 },
      { id: 'o2', status: 'pending', text: 'two', nextAttemptAt: 0, created: 22 },
    ],
  };
  assert.equal(store.accept(payload), true);
  assert.equal(store.accept({ ...payload, task: { id: 't1', status: 'overwritten' } }), false);
  assert.equal(store.getTask('t1').status, 'queued');
  assert.deepEqual(store.listOutbox().map((entry) => entry.id), ['o1', 'o2']);

  assert.throws(() => store.accept({
    eventId: 'ev2', task: { id: 't2' }, job: { id: 'bad-job', taskId: 't2' },
    outbox: { status: 'pending' },
  }), /Outbox entry must have an id/);
  assert.equal(store.getTask('t2'), null);
  assert.equal(store.getJob('bad-job'), null);
});

test('job queue and status lists are oldest first and status-filtered', (t) => {
  const { path } = database(t);
  const store = new Store(path);
  t.after(() => store.close());
  store.saveJob({ id: 'later', taskId: 't1', status: 'queued', created: 30 });
  store.saveJob({ id: 'done', taskId: 't1', status: 'done', created: 10 });
  store.saveJob({ id: 'first', taskId: 't2', status: 'queued', created: 20 });
  assert.equal(store.getJob(undefined), null);
  assert.equal(store.getJob(null), null);
  assert.equal(store.nextJob().id, 'first');
  assert.deepEqual(store.jobsForTask('t1').map((job) => job.id), ['done', 'later']);
  assert.deepEqual(store.listJobs('queued').map((job) => job.id), ['first', 'later']);
  assert.deepEqual(store.listJobs().map((job) => job.id), ['done', 'first', 'later']);
});

test('outbox filters pending entries by retry time and lists by status', (t) => {
  const { path } = database(t);
  const store = new Store(path);
  t.after(() => store.close());
  store.saveOutbox({ id: 'due', status: 'pending', nextAttemptAt: 50, created: 10 });
  store.saveOutbox({ id: 'later', status: 'pending', nextAttemptAt: 100, created: 20 });
  store.saveOutbox({ id: 'sent', status: 'sent', nextAttemptAt: 0, created: 30 });
  assert.deepEqual(store.pendingOutbox(50).map((entry) => entry.id), ['due']);
  assert.deepEqual(store.listOutbox('sent').map((entry) => entry.id), ['sent']);
});

test('instance lease claim is atomic across connections and released only by its owner', t => {
  const directory = mkdtempSync(join(tmpdir(), 'fix-code-instance-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = new Store(join(directory, 'state.sqlite'));
  const second = new Store(join(directory, 'state.sqlite'));
  t.after(() => first.close()); t.after(() => second.close());
  first.claimInstance({ pid: 123, identity: 'fixture-live', token: 'owner' }, () => false);
  assert.throws(() => second.claimInstance({ token: 'other' }, () => true), /already running/);
  second.releaseInstance('other');
  assert.equal(first.getInstance().token, 'owner');
  first.releaseInstance('owner');
  assert.equal(second.getInstance(), null);
  second.claimInstance({ token: 'new' }, () => false);
  assert.equal(first.getInstance().token, 'new');
});
