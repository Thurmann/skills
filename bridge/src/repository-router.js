import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { command, expectedRemote } from './git.js';

const canceled = () => new Error('Repository routing canceled.');
function checkSignal(signal) { if (signal?.aborted) throw canceled(); }
function normalizeName(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(value)) throw new Error('Slack channel name is invalid for repository routing.');
  return value;
}
function metadataObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`GitHub returned invalid ${label} metadata.`);
  return value;
}
function validBranch(value) { return typeof value === 'string' && value.length > 0 && !value.startsWith('-') && !value.includes('\0'); }
function pathExists(filename) { try { fs.lstatSync(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

export function createRepositoryRouter(config, { channelInfo, execute = command } = {}) {
  const routing = config?.repositoryRouting;
  const root = typeof routing?.cloneRoot === 'string' && path.isAbsolute(routing.cloneRoot) ? path.resolve(routing.cloneRoot) : null;
  const localRoot = typeof routing?.localRoot === 'string' && path.isAbsolute(routing.localRoot) ? fs.realpathSync(routing.localRoot) : null;
  const allowedOwners = Array.isArray(routing?.allowedOwners) ? routing.allowedOwners.map(value => String(value).toLowerCase()) : [];
  const channelOwners = routing?.channelOwners && typeof routing.channelOwners === 'object' ? routing.channelOwners : {};

  function requireRouting() {
    if (!routing || routing.mode !== 'channel' || !root) throw new Error('Channel repository routing requires an absolute repositoryRouting.cloneRoot.');
    if (typeof channelInfo !== 'function') throw new Error('Channel repository routing requires Slack channel metadata lookup.');
  }
  function managedRoot() { return fs.realpathSync(root); }
  function localPath(name) { return path.join(localRoot, name); }
  function ensureRoot() {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Managed repository clone root must be a real directory.');
    if (stat.mode & 0o077) throw new Error('Managed repository clone root must be private (mode 0700).');
  }

  function ownerAllowed(owner, channel) {
    const normalized = owner.toLowerCase();
    if (allowedOwners.length && !allowedOwners.includes(normalized)) return false;
    const hint = channelOwners[channel];
    return !hint || String(hint).toLowerCase() === normalized;
  }
  async function gh(args, signal) {
    checkSignal(signal);
    if (!config.allowNetwork) throw new Error('Network access is disabled; channel repository routing requires GitHub metadata.');
    const output = await execute(config.ghPath || 'gh', args, { signal });
    checkSignal(signal);
    return output;
  }
  async function branchIsValid(branch, signal) {
    if (!validBranch(branch)) return false;
    checkSignal(signal);
    try {
      await execute('git', ['check-ref-format', '--branch', branch], { signal });
      checkSignal(signal);
      return true;
    } catch (error) {
      checkSignal(signal);
      if (signal?.aborted) throw error;
      return false;
    }
  }
  async function resolve(task, signal) {
    requireRouting();
    checkSignal(signal);
    if (!config.allowNetwork) throw new Error('Network access is disabled; channel repository routing requires GitHub metadata.');
    if (typeof task?.channel !== 'string' || !task.channel) throw new Error('Task has no Slack channel ID.');
    // The private root is the only filesystem location resolve may create or inspect.
    ensureRoot();
    checkSignal(signal);
    const slack = await channelInfo(task.channel);
    checkSignal(signal);
    const channel = metadataObject(slack?.channel, 'Slack channel');
    if (channel.id !== task.channel) throw new Error('Slack channel metadata did not match the exact channel ID.');
    const channelName = normalizeName(channel.name);
    if (channel.is_archived === true) throw new Error('Archived Slack channels cannot be routed to repositories.');
    if (channel.is_ext_shared === true || channel.is_ext_shared_channel === true || channel.is_shared === true) throw new Error('External or shared Slack channels cannot be routed to repositories.');

    const jq = `[.[] | select((.name | ascii_downcase) == ${JSON.stringify(channelName.toLowerCase())}) | {id,name,full_name,owner:.owner.login,default_branch,archived,disabled,permissions:{push:.permissions.push}}] | @json`;
    const raw = await gh(['api', '--hostname', 'github.com', '--method', 'GET', '/user/repos?per_page=100&affiliation=owner,collaborator,organization_member', '--paginate', '--jq', jq], signal);
    let matches;
    try {
      matches = [];
      for (const line of raw.split(/\r?\n/).filter(line => line.length > 0)) {
        const page = JSON.parse(line);
        if (!Array.isArray(page)) throw new Error();
        matches.push(...page);
      }
    } catch { throw new Error('GitHub returned invalid repository metadata.'); }

    // Verify every exact-name result before filtering or deciding uniqueness.
    for (const candidate of matches) {
      metadataObject(candidate, 'repository');
      if (!Number.isSafeInteger(candidate.id) || candidate.id <= 0 || typeof candidate.name !== 'string' || candidate.name.toLowerCase() !== channelName.toLowerCase() ||
          typeof candidate.full_name !== 'string' || !/^[^/]+\/[^/]+$/.test(candidate.full_name) || candidate.full_name.split('/')[1].toLowerCase() !== channelName.toLowerCase() ||
          typeof candidate.owner !== 'string' || candidate.owner !== candidate.full_name.split('/')[0] ||
          !validBranch(candidate.default_branch) || typeof candidate.archived !== 'boolean' || typeof candidate.disabled !== 'boolean' ||
          typeof candidate.permissions?.push !== 'boolean') throw new Error('GitHub returned incomplete or inconsistent repository metadata.');
    }
    const eligibleOwners = matches.filter(repo => ownerAllowed(repo.owner, task.channel));
    if (eligibleOwners.length > 1) throw new Error(`More than one GitHub repository matches Slack channel #${channelName}; configure a channel owner hint.`);
    if (!eligibleOwners.length) throw new Error(`No GitHub repository matches Slack channel #${channelName} for an allowed owner.`);
    const repo = eligibleOwners[0];
    if (!repo.permissions.push) throw new Error('The matching GitHub repository is not writable by the configured account.');
    if (repo.archived || repo.disabled) throw new Error('The matching GitHub repository is archived or disabled.');
    if (!await branchIsValid(repo.default_branch, signal)) throw new Error('GitHub repository has an invalid default branch.');
    const local = localRoot && pathExists(localPath(repo.name));
    const selectedPath = local ? await validateLocal({ path: localPath(repo.name), github: repo.full_name }, signal) : path.join(managedRoot(), String(repo.id));
    return {
      channelName,
      repository: {
        path: selectedPath,
        base: `origin/${repo.default_branch}`,
        baseBranch: repo.default_branch,
        remote: 'origin',
        github: repo.full_name,
        githubId: repo.id,
        ...(local ? { storage: 'local' } : {})
      }
    };
  }

  function verifyBound(task) {
    const repo = task?.repository;
    if (!task || typeof task.channel !== 'string' || !task.channel || !task.channelName || normalizeName(task.channelName) !== task.channelName ||
        !repo || !Number.isSafeInteger(repo.githubId) || repo.githubId <= 0 || typeof repo.github !== 'string' || !/^[^/]+\/[^/]+$/.test(repo.github) || repo.github.split('/')[1].toLowerCase() !== task.channelName.toLowerCase() ||
        repo.remote !== 'origin' || !['local', 'managed', undefined].includes(repo.storage) ||
        (repo.storage === 'local' ? (!localRoot || repo.path !== localPath(repo.github.split('/')[1])) : repo.path !== path.join(managedRoot(), String(repo.githubId))) || repo.base !== `origin/${repo.baseBranch}` || !validBranch(repo.baseBranch)) {
      throw new Error('Task repository binding is missing or does not match its configured repository path.');
    }
    if (!ownerAllowed(repo.github.split('/')[0], task.channel)) throw new Error('Task repository owner is no longer allowed for this Slack channel.');
    return repo;
  }
  async function git(args, cwd, signal) {
    checkSignal(signal);
    const out = await execute('git', args, { cwd, signal });
    checkSignal(signal);
    return out;
  }
  function safeFinalPath(repo) {
    const parent = managedRoot();
    const target = path.resolve(repo.path);
    if (path.dirname(target) !== parent || path.basename(target) !== String(repo.githubId)) throw new Error('Managed clone path escaped its private root.');
    if (pathExists(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('Managed repository path must not be a symlink.');
    return target;
  }
  function validateLocalPath(name) {
    if (!localRoot) throw new Error('Task is bound to local storage but repositoryRouting.localRoot is not configured.');
    const target = localPath(name);
    if (path.dirname(target) !== localRoot || path.basename(target) !== name || !pathExists(target)) throw new Error('Bound local repository path is missing or escaped repositoryRouting.localRoot.');
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Local repository path must be a real directory, not a symlink.');
    return target;
  }
  async function validateLocal(repo, signal) {
    const target = validateLocalPath(repo.github.split('/')[1]);
    const top = await git(['rev-parse', '--show-toplevel'], target, signal);
    if (fs.realpathSync(top) !== target) throw new Error('Local repository path is not the exact Git root.');
    const gd = await git(['rev-parse', '--git-dir'], target, signal);
    const cd = await git(['rev-parse', '--git-common-dir'], target, signal);
    const absoluteGitDir = path.resolve(target, gd);
    if (fs.realpathSync(absoluteGitDir) !== path.join(target, '.git') || fs.realpathSync(path.resolve(target, cd)) !== fs.realpathSync(absoluteGitDir)) throw new Error('Local repository must be an ordinary checkout, not a linked worktree or external Git directory.');
    for (const args of [['remote', 'get-url', '--all', 'origin'], ['remote', 'get-url', '--push', '--all', 'origin']]) {
      const urls = (await git(args, target, signal)).split(/\r?\n/).filter(Boolean);
      if (!urls.length || urls.some(url => !expectedRemote(url, repo.github))) throw new Error('Local repository origin fetch/push URLs do not all match the bound GitHub repository.');
    }
    return target;
  }
  async function validateClone(repo, task, signal) {
    const target = safeFinalPath(repo);
    if (!pathExists(target) || !fs.lstatSync(target).isDirectory()) throw new Error('Managed repository clone is missing or is not a directory.');
    const top = await git(['rev-parse', '--show-toplevel'], target, signal);
    if (fs.realpathSync(top) !== fs.realpathSync(target)) throw new Error('Managed repository path is not the exact Git root.');
    const gitDirRaw = await git(['rev-parse', '--git-dir'], target, signal);
    const gitDir = path.resolve(target, gitDirRaw);
    if (gitDir !== target && !gitDir.startsWith(`${target}${path.sep}`)) throw new Error('Managed repository Git directory escaped its clone path.');
    const marker = path.join(gitDir, 'fix-code-managed.json');
    let binding;
    try {
      if (fs.lstatSync(marker).isSymbolicLink()) throw new Error();
      binding = JSON.parse(fs.readFileSync(marker, 'utf8'));
    } catch { throw new Error('Managed clone has no valid control marker; refusing to adopt it.'); }
    if (binding.githubId !== repo.githubId || binding.github !== repo.github) throw new Error('Managed clone identity marker does not match this task binding.');
    const remote = await git(['remote', 'get-url', 'origin'], target, signal);
    const pushRemote = await git(['remote', 'get-url', '--push', 'origin'], target, signal);
    if (!expectedRemote(remote, repo.github) || !expectedRemote(pushRemote, repo.github)) throw new Error('Managed clone origin does not match the bound GitHub repository.');
    await git(['fetch', '--refmap=', 'origin', `+refs/heads/${repo.baseBranch}:refs/remotes/origin/${repo.baseBranch}`], target, signal);
    await git(['rev-parse', '--verify', `refs/remotes/origin/${repo.baseBranch}^{commit}`], target, signal);
    return { ...repo, path: target };
  }
  async function prepare(task, signal) {
    requireRouting();
    checkSignal(signal);
    if (!config.allowNetwork) throw new Error('Network access is disabled; repository preparation requires GitHub metadata.');
    ensureRoot();
    const repo = verifyBound(task);
    const current = await gh(['api', '--hostname', 'github.com', '--method', 'GET', `/repos/${repo.github}`], signal);
    let metadata;
    try { metadata = JSON.parse(current); } catch { throw new Error('GitHub returned invalid bound repository metadata.'); }
    metadataObject(metadata, 'bound repository');
    if (metadata.id !== repo.githubId || metadata.full_name !== repo.github || metadata.default_branch !== repo.baseBranch) throw new Error('Bound GitHub repository identity or default branch changed; refusing to reroute this task.');
    if (metadata.archived === true || metadata.disabled === true || metadata.permissions?.push !== true) throw new Error('Bound GitHub repository is no longer writable and active.');
    const target = repo.storage === 'local' ? validateLocalPath(repo.github.split('/')[1]) : safeFinalPath(repo);
    if (repo.storage === 'local') {
      await validateLocal(repo, signal);
      await git(['fetch', '--refmap=', 'origin', `+refs/heads/${repo.baseBranch}:refs/remotes/origin/${repo.baseBranch}`], target, signal);
      await git(['rev-parse', '--verify', `refs/remotes/origin/${repo.baseBranch}^{commit}`], target, signal);
      return { ...repo, path: target };
    }
    if (pathExists(target)) return validateClone(repo, task, signal);

    checkSignal(signal);
    const temporary = path.join(managedRoot(), `.clone-${repo.githubId}-${randomUUID()}`);
    await gh(['repo', 'clone', `https://github.com/${repo.github}.git`, temporary], signal);
    checkSignal(signal);
    // Validate the temporary clone before it can become the stable managed path.
    const tempTop = await git(['rev-parse', '--show-toplevel'], temporary, signal);
    if (fs.realpathSync(tempTop) !== fs.realpathSync(temporary)) throw new Error('Cloned repository is not rooted at its temporary path.');
    const remote = await git(['remote', 'get-url', 'origin'], temporary, signal);
    const pushRemote = await git(['remote', 'get-url', '--push', 'origin'], temporary, signal);
    if (!expectedRemote(remote, repo.github) || !expectedRemote(pushRemote, repo.github)) throw new Error('Cloned repository origin does not match the bound GitHub repository.');
    await git(['rev-parse', '--verify', `refs/remotes/origin/${repo.baseBranch}^{commit}`], temporary, signal);
    const gitDirRaw = await git(['rev-parse', '--git-dir'], temporary, signal);
    const gitDir = path.resolve(temporary, gitDirRaw);
    if (gitDir !== temporary && !gitDir.startsWith(`${temporary}${path.sep}`)) throw new Error('Cloned repository Git directory escaped its temporary path.');
    fs.writeFileSync(path.join(gitDir, 'fix-code-managed.json'), JSON.stringify({ githubId: repo.githubId, github: repo.github }), { flag: 'wx', mode: 0o600 });
    checkSignal(signal);
    if (pathExists(target)) throw new Error('Managed repository path appeared during clone preparation; inspect it locally.');
    fs.renameSync(temporary, target);
    checkSignal(signal);
    return validateClone(repo, task, signal);
  }
  return { resolve, prepare };
}
