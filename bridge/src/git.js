import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function commandEnv() {
  const result = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SSH_AUTH_SOCK', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST']) {
    if (process.env[key]) result[key] = process.env[key];
  }
  result.GH_HOST = 'github.com'; // This publisher/resolver supports GitHub.com only.
  result.GIT_TERMINAL_PROMPT = '0';
  return result;
}
export function command(executable, args, { cwd, signal, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Command canceled.')); return; }
    const child = spawn(executable, args, { cwd, env: commandEnv(), shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', failure, killTimer, settled = false, termination;
    let finishTermination;
    const kill = name => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, name); else child.kill(name); } catch {} };
    const terminate = message => { if (failure || settled) return; failure = message; termination = new Promise(resolve => { finishTermination = resolve; }); kill('SIGTERM'); killTimer = setTimeout(() => { kill('SIGKILL'); setTimeout(finishTermination, 100); }, 750); };
    const abort = () => terminate('Command canceled; inspect preserved task state.');
    const timer = setTimeout(() => terminate('Command timed out; inspect local command state.'), timeout);
    const cleanup = () => { settled = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 2000000) terminate('Command exceeded its output limit.'); });
    child.stderr.on('data', () => {}); // Never surface credential/helper stderr in Slack.
    child.on('error', error => { cleanup(); reject(new Error(`${path.basename(executable)} could not run (${error.code || 'error'}).`)); });
    child.on('close', async code => {
      if (termination) await termination;
      cleanup();
      if (failure) reject(new Error(failure));
      else if (code !== 0) reject(new Error(`${path.basename(executable)} ${args[0]} failed; inspect local authentication, permissions, or command state. No raw stderr was posted.`));
      else resolve(stdout.trim());
    });
    if (signal?.aborted) abort();
  });
}
export function expectedRemote(url, github) {
  let actual;
  if (/^git@github\.com:/i.test(url)) actual = url.slice('git@github.com:'.length);
  else {
    try { const parsed = new URL(url); if (parsed.hostname !== 'github.com' || parsed.protocol !== 'https:') return false; actual = parsed.pathname.slice(1); }
    catch { return false; }
  }
  return actual.replace(/\.git$/, '').replace(/\/$/, '').toLowerCase() === github.toLowerCase();
}
export async function validateRepository(repo, signal) {
  const top = await command('git', ['rev-parse', '--show-toplevel'], { cwd: repo.path, signal });
  if (fs.realpathSync(top) !== fs.realpathSync(repo.path)) throw new Error('Configured repository path must be its exact root.');
  for (const [args, label] of [[['remote', 'get-url', '--all', repo.remote], 'fetch'], [['remote', 'get-url', '--push', '--all', repo.remote], 'push']]) {
    const urls = (await command('git', args, { cwd: repo.path, signal })).split(/\r?\n/).filter(Boolean);
    if (!urls.length || urls.some(url => !expectedRemote(url, repo.github))) throw new Error(`Repository ${label} remote does not match the configured GitHub owner/repository.`);
  }
}
export async function guardCheck(config, state, signal) {
  return JSON.parse(await command(config.pythonPath, [path.join(config.skillPath, 'scripts/git_guard.py'), 'check', '--state', state], { signal }));
}
export async function prepareTask(config, task, signal) {
  const repo = task.repository;
  await validateRepository(repo, signal);
  if (task.guardState) {
    await guardCheck(config, task.guardState, signal);
    return task;
  }
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const repositoryName = path.basename(path.resolve(repo.path));
  const worktreeName = `fix-code-${String(task.id).replace(/[^A-Za-z0-9._-]+/g, '-')}`;
  const worktreesRoot = config.worktreesRoot || path.join(os.homedir(), 'workspace', 'worktrees');
  const worktree = path.join(worktreesRoot, repositoryName, worktreeName);
  // Reconcile a crash after the helper created a worktree but before SQLite saved it.
  if (fs.existsSync(worktree)) {
    const commonRaw = await command('git', ['rev-parse', '--git-common-dir'], { cwd: repo.path, signal });
    const common = path.resolve(repo.path, commonRaw);
    const folder = path.join(common, 'fix-code');
    for (const filename of fs.existsSync(folder) ? fs.readdirSync(folder) : []) {
      if (!filename.endsWith('.json')) continue;
      const statePath = path.join(folder, filename);
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (state.worktree === worktree && state.base_ref === repo.base) {
        await guardCheck(config, statePath, signal);
        return { ...task, worktree, branch: state.branch, guardState: statePath, gitCommonDir: common, baseCommit: state.base_commit };
      }
    }
    throw new Error('Task worktree exists without a matching guard checkpoint; inspect locally before retrying.');
  }
  if (config.allowNetwork) await command('git', ['fetch', '--refmap=', repo.remote, `+refs/heads/${repo.baseBranch}:refs/remotes/${repo.remote}/${repo.baseBranch}`], { cwd: repo.path, signal });
  const state = JSON.parse(await command(config.pythonPath, [path.join(config.skillPath, 'scripts/git_guard.py'), 'start', '--repo', repo.path, '--name', task.id, '--base', repo.base, '--protect', repo.baseBranch, '--worktree', worktree], { signal }));
  const saved = JSON.parse(fs.readFileSync(state.state, 'utf8'));
  return { ...task, worktree: state.worktree, branch: state.branch, guardState: state.state, gitCommonDir: saved.git_common_dir, baseCommit: saved.base_commit };
}
async function findPR(config, task, signal) {
  const entries = JSON.parse(await command(config.ghPath, ['pr', 'list', '--repo', task.repository.github, '--head', task.branch, '--state', 'all', '--json', 'number,url,state,isDraft,baseRefName,headRefName'], { cwd: task.worktree, signal }));
  return entries.find(pr => pr.headRefName === task.branch && pr.baseRefName === task.repository.baseBranch);
}
export async function checkExistingPR(config, task, signal) {
  const pr = await findPR(config, task, signal);
  if (pr && pr.state !== 'OPEN') throw new Error('This change already has a merged/closed PR. Start a new top-level Slack task for a fresh branch.');
  if (pr && pr.isDraft !== true) throw new Error('This PR is no longer a draft. Return it to draft locally or start a new task before further changes.');
  return pr;
}
export async function publishPR(config, task, result, outputDir, signal) {
  await guardCheck(config, task.guardState, signal);
  await validateRepository(task.repository, signal);
  if (!config.allowNetwork) throw new Error('Network publication is disabled in local configuration; the verified branch is preserved.');
  if (await command('git', ['status', '--porcelain'], { cwd: task.worktree, signal })) throw new Error('Implementation left uncommitted files; PR publication stopped.');
  const count = Number(await command('git', ['rev-list', '--count', `${task.baseCommit}..HEAD`], { cwd: task.worktree, signal }));
  if (!count) throw new Error('No task commits were created; no PR was published.');
  const existing = await checkExistingPR(config, task, signal);
  await command('git', ['push', task.repository.remote, `HEAD:refs/heads/${task.branch}`], { cwd: task.worktree, signal });
  await guardCheck(config, task.guardState, signal);
  let pr = existing;
  if (!pr) {
    const body = path.join(outputDir, 'pull-request.md');
    fs.writeFileSync(body, `This change addresses the authenticated Slack task ${task.id}.\n\n${result.slice(0, 12000)}\n\nValidation and independent review completed before publication. Review the evidence and diff before merging.\n`, { mode: 0o600 });
    const title = `fix-code: ${task.initialRequest.split('\n')[0]}`.slice(0, 100);
    await command(config.ghPath, ['pr', 'create', '--repo', task.repository.github, '--head', task.branch, '--base', task.repository.baseBranch, '--draft', '--title', title, '--body-file', body], { cwd: task.worktree, signal });
    pr = await findPR(config, task, signal);
  }
  if (!pr || pr.state !== 'OPEN' || pr.isDraft !== true || !/^https:\/\/github\.com\//.test(pr.url)) throw new Error('PR creation could not be verified. Inspect the branch/forge before retrying.');
  return pr.url;
}
