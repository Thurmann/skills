import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRepositoryRouter } from '../src/repository-router.js';

const gitSync = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
function fixture(t, config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-router-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cloneRoot = path.join(root, 'managed');
  const cfg = { allowNetwork: true, ghPath: 'gh', repositoryRouting: { mode: 'channel', cloneRoot, ...config } };
  return { root, cloneRoot, config: cfg };
}
const channel = (name = 'widget', extra = {}) => ({ channel: { id: 'C123', name, is_archived: false, is_ext_shared: false, ...extra } });
const repo = (id, owner = 'Acme', name = 'widget', extra = {}) => ({ id, name, full_name: `${owner}/${name}`, owner, default_branch: 'main', archived: false, disabled: false, permissions: { push: true }, ...extra });
function routingFixture(t, { channels = channel(), repos = [repo(123)], listingOutput, config = {} } = {}) {
  const base = fixture(t, config);
  const calls = [];
  const execute = async (exe, args, opts = {}) => {
    calls.push({ exe, args, opts });
    if (exe === 'gh' && args[0] === 'api' && args.includes('/user/repos?per_page=100&affiliation=owner,collaborator,organization_member')) return listingOutput ?? JSON.stringify(repos);
    if (exe === 'gh' && args[0] === 'api' && args[5]?.startsWith('/repos/')) {
      const full = args[5].slice('/repos/'.length);
      const bound = repos.find(r => r.full_name === full);
      return JSON.stringify({ id: bound?.id ?? 123, full_name: full, default_branch: bound?.default_branch ?? 'main', archived: false, disabled: false, permissions: { push: true } });
    }
    if (exe === 'gh' && args[0] === 'repo' && args[1] === 'clone') {
      const dest = args[3];
      if (execute.cloneFailure) { fs.mkdirSync(dest, { recursive: true }); throw new Error('fixture clone failure'); }
      fs.mkdirSync(dest, { recursive: true });
      gitSync(dest, 'init', '--initial-branch=main');
      gitSync(dest, 'config', 'user.name', 'Fixture'); gitSync(dest, 'config', 'user.email', 'fixture@example.invalid');
      fs.writeFileSync(path.join(dest, 'README.md'), 'fixture\n'); gitSync(dest, 'add', 'README.md'); gitSync(dest, 'commit', '-m', 'fixture');
      gitSync(dest, 'remote', 'add', 'origin', args[2]);
      gitSync(dest, 'update-ref', 'refs/remotes/origin/main', gitSync(dest, 'rev-parse', 'HEAD'));
      return '';
    }
    if (exe === 'git') {
      if (args[0] === 'check-ref-format') return 'main';
      if (args[0] === 'fetch' && args.includes('origin')) {
        const branch = args.at(-1).match(/^\+?refs\/heads\/([^:]+)/)[1];
        const commit = gitSync(opts.cwd, 'rev-parse', `refs/heads/${branch}`);
        gitSync(opts.cwd, 'update-ref', `refs/remotes/origin/${branch}`, commit);
        return '';
      }
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return gitSync(opts.cwd, 'rev-parse', '--show-toplevel');
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') return gitSync(opts.cwd, 'rev-parse', '--git-dir');
      if (args[0] === 'remote' && args[1] === 'get-url') return gitSync(opts.cwd, ...args);
      if (args[0] === 'rev-parse' && args[1] === '--verify') return gitSync(opts.cwd, ...args);
    }
    throw new Error(`Unexpected fixture command: ${exe} ${args.join(' ')}`);
  };
  const router = createRepositoryRouter(base.config, { channelInfo: async id => { assert.equal(id, 'C123'); return channels; }, execute });
  return { ...base, calls, execute, router, repos };
}

test('resolve uses exact case-insensitive channel-name match, Slack metadata, and all-page GitHub query', async t => {
  const f = routingFixture(t, { channels: channel('Widget'), repos: [repo(123, 'Acme', 'widget')] });
  const result = await f.router.resolve({ channel: 'C123', initialRequest: 'use somebody-elses/repo' });
  assert.equal(result.channelName, 'Widget');
  assert.deepEqual(result.repository, { path: path.join(fs.realpathSync(f.cloneRoot), '123'), base: 'origin/main', baseBranch: 'main', remote: 'origin', github: 'Acme/widget', githubId: 123 });
  const listing = f.calls.find(call => call.exe === 'gh' && call.args.includes('/user/repos?per_page=100&affiliation=owner,collaborator,organization_member'));
  assert.ok(listing.args.includes('--paginate'));
  assert.equal(listing.args.includes('--slurp'), false);
  assert.ok(listing.args.includes('--jq'));
  assert.match(listing.args.at(-1), /\.\[\] \| select/);
  assert.match(listing.args.at(-1), /\| @json$/);
  assert.equal(fs.existsSync(result.repository.path), false, 'resolve must not clone or create task paths');
});

test('resolve parses each paginated jq JSON line and finds a match on a later page', async t => {
  const f = routingFixture(t, { repos: [repo(123)], listingOutput: `${JSON.stringify([])}\n${JSON.stringify([repo(123)])}\n` });
  const result = await f.router.resolve({ channel: 'C123' });
  assert.equal(result.repository.github, 'Acme/widget');
});

test('resolve rejects duplicate exact matches across pages', async t => {
  const f = routingFixture(t, { listingOutput: `${JSON.stringify([repo(1)])}\n${JSON.stringify([repo(2, 'Other')])}` });
  await assert.rejects(f.router.resolve({ channel: 'C123' }), /More than one/);
});

test('resolve accepts empty listing output and rejects malformed or non-array page output', async t => {
  const empty = routingFixture(t, { listingOutput: '' });
  await assert.rejects(empty.router.resolve({ channel: 'C123' }), /No GitHub repository/);
  for (const listingOutput of ['{bad json}', JSON.stringify(repo(1)), `${JSON.stringify([])}\n{bad}`]) {
    const f = routingFixture(t, { listingOutput });
    await assert.rejects(f.router.resolve({ channel: 'C123' }), /invalid repository metadata/);
  }
});

test('resolve rejects invalid, archived, or externally shared Slack channel metadata', async t => {
  for (const slack of [channel('widget', { id: 'COTHER' }), channel('bad/name'), channel('widget', { is_archived: true }), channel('widget', { is_ext_shared_channel: true })]) {
    const f = routingFixture(t, { channels: slack });
    await assert.rejects(f.router.resolve({ channel: 'C123' }));
    assert.equal(f.calls.filter(call => call.exe === 'gh').length, 0);
  }
});

test('owner hint disambiguates duplicates; duplicates still reject when one is read-only or archived', async t => {
  const f = routingFixture(t, { repos: [repo(1, 'Acme'), repo(2, 'Other')], config: { channelOwners: { C123: 'Other' } } });
  const result = await f.router.resolve({ channel: 'C123' });
  assert.equal(result.repository.github, 'Other/widget');
  const ambiguous = routingFixture(t, { repos: [repo(1, 'Acme'), repo(2, 'Other', 'widget', { permissions: { push: false }, archived: true })] });
  await assert.rejects(ambiguous.router.resolve({ channel: 'C123' }), /More than one/);
});

test('resolve rejects no match, readonly or archived match, and invalid metadata', async t => {
  for (const repos of [[], [repo(1, 'Acme', 'widget', { permissions: { push: false } })], [repo(1, 'Acme', 'widget', { archived: true })], [repo(1, 'Acme', 'widget', { default_branch: '' })]]) {
    const f = routingFixture(t, { repos });
    await assert.rejects(f.router.resolve({ channel: 'C123' }));
  }
});

test('prepare blocks replaced, renamed, transferred, or default-branch-changed repository identity', async t => {
  const f = routingFixture(t);
  const binding = await f.router.resolve({ channel: 'C123' });
  const task = { channel: 'C123', channelName: binding.channelName, repository: binding.repository };
  // Router keeps its injected executor; use a distinct router with changed authoritative metadata.
  const oldExecute = f.execute;
  const changed = createRepositoryRouter(f.config, { channelInfo: async () => channel(), execute: async (exe, args, opts) => {
    if (exe === 'gh' && args[0] === 'api' && args[5] === '/repos/Acme/widget') return JSON.stringify({ id: 999, full_name: 'Other/widget', default_branch: 'develop', permissions: { push: true } });
    return oldExecute(exe, args, opts);
  } });
  await assert.rejects(changed.prepare(task), /identity or default branch changed/);
});

test('prepare safely clones, promotes atomically, marks identity, and reuses the managed clone', async t => {
  const f = routingFixture(t);
  const binding = await f.router.resolve({ channel: 'C123' });
  const task = { channel: 'C123', channelName: binding.channelName, repository: binding.repository };
  assert.deepEqual(await f.router.prepare(task), binding.repository);
  const clonePath = binding.repository.path;
  assert.equal(fs.existsSync(path.join(clonePath, '.git', 'fix-code-managed.json')), true);
  const before = f.calls.filter(call => call.exe === 'gh' && call.args[0] === 'repo').length;
  assert.deepEqual(await f.router.prepare(task), binding.repository);
  assert.equal(f.calls.filter(call => call.exe === 'gh' && call.args[0] === 'repo').length, before);
});

test('prepare fetches a newly bound default branch into an existing managed clone', async t => {
  const f = routingFixture(t);
  const initial = await f.router.resolve({ channel: 'C123' });
  await f.router.prepare({ channel: 'C123', channelName: initial.channelName, repository: initial.repository });
  const clone = initial.repository.path;
  gitSync(clone, 'branch', 'develop');
  f.repos[0].default_branch = 'develop';

  const next = await f.router.resolve({ channel: 'C123' });
  assert.equal(next.repository.path, initial.repository.path);
  assert.equal(next.repository.baseBranch, 'develop');
  const beforeFetch = f.calls.filter(call => call.exe === 'git' && call.args[0] === 'fetch').length;
  const prepared = await f.router.prepare({ channel: 'C123', channelName: next.channelName, repository: next.repository });
  assert.deepEqual(prepared, next.repository);
  assert.equal(f.calls.filter(call => call.exe === 'git' && call.args[0] === 'fetch').length, beforeFetch + 1);
  assert.equal(gitSync(clone, 'rev-parse', '--verify', 'refs/remotes/origin/develop^{commit}'), gitSync(clone, 'rev-parse', 'refs/heads/develop'));
});

test('prepare refuses an existing clone without a matching marker and refuses symlink paths', async t => {
  const f = routingFixture(t);
  const binding = await f.router.resolve({ channel: 'C123' });
  const task = { channel: 'C123', channelName: binding.channelName, repository: binding.repository };
  fs.mkdirSync(binding.repository.path, { recursive: true });
  gitSync(binding.repository.path, 'init', '--initial-branch=main');
  await assert.rejects(f.router.prepare(task), /control marker/);
  fs.rmSync(binding.repository.path, { recursive: true, force: true });
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, binding.repository.path);
  await assert.rejects(f.router.prepare(task), /symlink/);
});

test('prepare leaves failed partial clone intact and does not promote it', async t => {
  const f = routingFixture(t);
  const binding = await f.router.resolve({ channel: 'C123' });
  const task = { channel: 'C123', channelName: binding.channelName, repository: binding.repository };
  f.execute.cloneFailure = true;
  await assert.rejects(f.router.prepare(task), /fixture clone failure/);
  assert.equal(fs.existsSync(binding.repository.path), false);
  assert.equal(fs.readdirSync(f.cloneRoot).some(name => name.startsWith('.clone-')), true);
});

test('network disabled and cancellation before or after Slack lookup prevents GitHub calls and cloning', async t => {
  const f = routingFixture(t);
  f.config.allowNetwork = false;
  await assert.rejects(f.router.resolve({ channel: 'C123' }), /Network access is disabled/);
  f.config.allowNetwork = true;
  const before = new AbortController(); before.abort();
  await assert.rejects(f.router.resolve({ channel: 'C123' }, before.signal), /canceled/);
  const after = new AbortController();
  const router = createRepositoryRouter(f.config, { channelInfo: async () => { after.abort(); return channel(); }, execute: f.execute });
  await assert.rejects(router.resolve({ channel: 'C123' }, after.signal), /canceled/);
  assert.equal(f.calls.filter(call => call.exe === 'gh').length, 0);
  assert.equal(fs.readdirSync(f.cloneRoot).length, 0);
});

test('prepare checks cancellation before clone and after a completed clone before promotion', async t => {
  const f = routingFixture(t);
  const binding = await f.router.resolve({ channel: 'C123' });
  const task = { channel: 'C123', channelName: binding.channelName, repository: binding.repository };
  const before = new AbortController(); before.abort();
  await assert.rejects(f.router.prepare(task, before.signal), /canceled/);
  const after = new AbortController();
  const router = createRepositoryRouter(f.config, { channelInfo: async () => channel(), execute: async (exe, args, opts) => {
    const result = await f.execute(exe, args, opts);
    if (exe === 'gh' && args[0] === 'repo') after.abort();
    return result;
  } });
  await assert.rejects(router.prepare(task, after.signal), /canceled/);
  assert.equal(fs.existsSync(binding.repository.path), false);
  assert.equal(fs.readdirSync(f.cloneRoot).some(name => name.startsWith('.clone-')), true);
});

test('prepare rejects tasks with a repository path outside the numeric managed ID path', async t => {
  const f = routingFixture(t);
  const binding = await f.router.resolve({ channel: 'C123' });
  const task = { channel: 'C123', channelName: binding.channelName, repository: { ...binding.repository, path: path.join(f.cloneRoot, 'some-user-path') } };
  const before = f.calls.filter(call => call.exe === 'gh').length;
  await assert.rejects(f.router.prepare(task), /configured repository path/);
  assert.equal(f.calls.filter(call => call.exe === 'gh').length, before);
});

test('localRoot reuses a verified checkout without cloning and preserves dirty files', async t => {
  const f = routingFixture(t);
  const localRoot = path.join(f.root, 'workspace'); fs.mkdirSync(localRoot);
  const canonicalLocalRoot = fs.realpathSync(localRoot);
  const checkout = path.join(localRoot, 'widget'); fs.mkdirSync(checkout);
  gitSync(checkout, 'init', '--initial-branch=main');
  gitSync(checkout, 'config', 'user.name', 'Fixture'); gitSync(checkout, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(checkout, 'tracked'), 'before\n'); gitSync(checkout, 'add', 'tracked'); gitSync(checkout, 'commit', '-m', 'fixture');
  gitSync(checkout, 'remote', 'add', 'origin', 'https://github.com/Acme/widget.git');
  gitSync(checkout, 'update-ref', 'refs/remotes/origin/main', gitSync(checkout, 'rev-parse', 'HEAD'));
  fs.writeFileSync(path.join(checkout, 'tracked'), 'user changes\n');
  const dirty = gitSync(checkout, 'status', '--porcelain');
  f.config.repositoryRouting.localRoot = canonicalLocalRoot;
  const real = f.execute;
  f.execute = async (exe, args, opts = {}) => {
    if (exe === 'git' && opts.cwd?.startsWith(canonicalLocalRoot)) {
      if (args[0] === 'fetch') {
        const commit = gitSync(checkout, 'rev-parse', 'refs/heads/main');
        gitSync(checkout, 'update-ref', 'refs/remotes/origin/main', commit);
        return '';
      }
      return gitSync(opts.cwd, ...args);
    }
    return real(exe, args, opts);
  };
  const router = createRepositoryRouter(f.config, { channelInfo: async () => channel(), execute: f.execute });
  const binding = await router.resolve({ channel: 'C123' });
  assert.equal(binding.repository.path, fs.realpathSync(checkout));
  assert.equal(binding.repository.storage, 'local');
  const prepared = await router.prepare({ channel: 'C123', channelName: binding.channelName, repository: binding.repository });
  assert.deepEqual(prepared, binding.repository);
  assert.equal(gitSync(checkout, 'status', '--porcelain'), dirty);
  assert.equal(fs.readFileSync(path.join(checkout, 'tracked'), 'utf8'), 'user changes\n');
  assert.equal(f.calls.some(call => call.exe === 'gh' && call.args[0] === 'repo'), false);
});

test('localRoot missing checkout falls back to managed; invalid present paths fail closed', async t => {
  const f = routingFixture(t);
  const localRoot = path.join(f.root, 'workspace'); fs.mkdirSync(localRoot);
  const canonicalLocalRoot = fs.realpathSync(localRoot);
  f.config.repositoryRouting.localRoot = canonicalLocalRoot;
  const router = createRepositoryRouter(f.config, { channelInfo: async () => channel(), execute: f.execute });
  const binding = await router.resolve({ channel: 'C123' });
  assert.equal(binding.repository.storage, undefined);
  assert.equal(binding.repository.path, path.join(fs.realpathSync(f.cloneRoot), '123'));

  const wrong = path.join(localRoot, 'widget'); fs.mkdirSync(wrong);
  gitSync(wrong, 'init', '--initial-branch=main');
  gitSync(wrong, 'remote', 'add', 'origin', 'https://github.com/Other/widget.git');
  const real = f.execute;
  f.execute = async (exe, args, opts = {}) => exe === 'git' && opts.cwd?.startsWith(canonicalLocalRoot) ? gitSync(opts.cwd, ...args) : real(exe, args, opts);
  const invalidRouter = createRepositoryRouter(f.config, { channelInfo: async () => channel(), execute: f.execute });
  await assert.rejects(invalidRouter.resolve({ channel: 'C123' }), /origin fetch\/push URLs/);
});

test('local binding stays pinned when localRoot changes or disappears', async t => {
  const f = routingFixture(t);
  const localRoot = path.join(f.root, 'workspace'); fs.mkdirSync(localRoot);
  const canonicalLocalRoot = fs.realpathSync(localRoot);
  const checkout = path.join(localRoot, 'widget'); fs.mkdirSync(checkout);
  gitSync(checkout, 'init', '--initial-branch=main');
  gitSync(checkout, 'config', 'user.name', 'Fixture'); gitSync(checkout, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(checkout, 'tracked'), 'ok'); gitSync(checkout, 'add', 'tracked'); gitSync(checkout, 'commit', '-m', 'fixture');
  gitSync(checkout, 'remote', 'add', 'origin', 'https://github.com/Acme/widget.git');
  f.config.repositoryRouting.localRoot = canonicalLocalRoot;
  const real = f.execute;
  f.execute = async (exe, args, opts = {}) => exe === 'git' && opts.cwd?.startsWith(canonicalLocalRoot) ? gitSync(opts.cwd, ...args) : real(exe, args, opts);
  const router = createRepositoryRouter(f.config, { channelInfo: async () => channel(), execute: f.execute });
  const binding = await router.resolve({ channel: 'C123' });
  const task = { channel: 'C123', channelName: binding.channelName, repository: binding.repository };
  fs.rmSync(checkout, { recursive: true, force: true });
  await assert.rejects(router.prepare(task), /missing or escaped/);
  const another = path.join(f.root, 'another'); fs.mkdirSync(another);
  f.config.repositoryRouting.localRoot = fs.realpathSync(another);
  const changedRouter = createRepositoryRouter(f.config, { channelInfo: async () => channel(), execute: f.execute });
  await assert.rejects(changedRouter.prepare(task), /configured repository path/);
});


test('localRoot rejects symlinks, external Git directories, and mismatching secondary push URLs', async t => {
  for (const kind of ['symlink', 'external', 'push-url']) {
    const f = routingFixture(t);
    const localRoot = path.join(f.root, 'workspace'); fs.mkdirSync(localRoot);
    const checkout = path.join(localRoot, 'widget');
    if (kind === 'symlink') {
      const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
      fs.symlinkSync(outside, checkout);
    } else {
      const args = ['init', '--initial-branch=main'];
      if (kind === 'external') args.push('--separate-git-dir', path.join(f.root, 'external.git'));
      gitSync(f.root, ...args, checkout);
      gitSync(checkout, 'remote', 'add', 'origin', 'https://github.com/Acme/widget.git');
      if (kind === 'push-url') {
        gitSync(checkout, 'remote', 'set-url', '--push', 'origin', 'https://github.com/Acme/widget.git');
        gitSync(checkout, 'remote', 'set-url', '--add', '--push', 'origin', 'https://github.com/Other/widget.git');
      }
    }
    f.config.repositoryRouting.localRoot = localRoot;
    const router = createRepositoryRouter(f.config, {
      channelInfo: async () => channel(),
      execute: (exe, args, opts = {}) => exe === 'git' ? gitSync(opts.cwd || f.root, ...args) : f.execute(exe, args, opts)
    });
    await assert.rejects(router.resolve({ channel: 'C123' }), /symlink|ordinary checkout|origin fetch\/push URLs/);
    assert.equal(f.calls.some(call => call.exe === 'gh' && call.args[0] === 'repo'), false);
  }
});

test('a managed binding stays pinned when a local candidate later appears', async t => {
  const f = routingFixture(t);
  const binding = await f.router.resolve({ channel: 'C123' });
  const localRoot = path.join(f.root, 'workspace'); fs.mkdirSync(localRoot);
  fs.mkdirSync(path.join(localRoot, 'widget'));
  f.config.repositoryRouting.localRoot = localRoot;
  const router = createRepositoryRouter(f.config, { channelInfo: async () => channel(), execute: f.execute });
  const prepared = await router.prepare({ channel: 'C123', channelName: binding.channelName, repository: binding.repository });
  assert.equal(prepared.path, binding.repository.path);
  assert.equal(prepared.storage, undefined);
});
