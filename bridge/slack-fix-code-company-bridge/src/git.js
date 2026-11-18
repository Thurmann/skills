import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { errorDetail } from './errors.js';

let githubAuth = { tokenFile: null, app: false, ghPath: 'gh' };
const APP_TOKEN_MAX_AGE_MS = 60 * 60000;
/** Set once at startup from config; a null token file leaves the environment exactly as before. */
export function configureGitHubAuth({ githubTokenFile, githubAuth: mode, ghPath } = {}) { githubAuth = { tokenFile: githubTokenFile || null, app: mode === 'app', ghPath: ghPath || 'gh' }; }
const usesGitHub = executable => executable === githubAuth.ghPath || ['git', 'gh'].includes(path.basename(executable));
/** Read and validate the token file; errors name the path only, never its contents. */
export function readGitHubToken(file, { maxAgeMs, now = Date.now() } = {}) {
  let stat, raw;
  try { stat = fs.statSync(file); }
  catch (error) { throw new Error(error.code === 'ENOENT' ? `GitHub token file ${file} is missing; check the token refresh job.` : `GitHub token file ${file} could not be read (${error.code || 'error'}).`); }
  if (!stat.isFile()) throw new Error(`GitHub token file ${file} is not a regular file.`);
  if (maxAgeMs !== undefined && now - stat.mtimeMs > maxAgeMs) throw new Error(`GitHub token file ${file} is ${Math.floor((now - stat.mtimeMs) / 60000)} minutes old (limit ${Math.floor(maxAgeMs / 60000)}); check the token refresh job.`);
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { throw new Error(`GitHub token file ${file} could not be read (${error.code || 'error'}).`); }
  const token = raw.trim();
  if (!token) throw new Error(`GitHub token file ${file} is empty; check the token refresh job.`);
  if (!/^\S+$/.test(token)) throw new Error(`GitHub token file ${file} must contain exactly one token.`);
  return token;
}
export function checkGitHubTokenFile(file, options) { return readGitHubToken(file, options); }
export function commandEnv(executable) {
  const result = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SSH_AUTH_SOCK', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST']) {
    if (process.env[key]) result[key] = process.env[key];
  }
  if (githubAuth.tokenFile) {
    delete result.GH_TOKEN; delete result.GITHUB_TOKEN;
    if (usesGitHub(executable)) result.GH_TOKEN = readGitHubToken(githubAuth.tokenFile, { maxAgeMs: githubAuth.app ? APP_TOKEN_MAX_AGE_MS : undefined });
  }
  result.GH_HOST = 'github.com'; // This publisher/resolver supports GitHub.com only.
  result.GIT_TERMINAL_PROMPT = '0';
  return result;
}
export function command(executable, args, { cwd, signal, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Command canceled.')); return; }
    let env;
    try { env = commandEnv(executable); } catch (error) { reject(error); return; }
    const child = spawn(executable, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure, killTimer, settled = false, termination;
    let finishTermination;
    const kill = name => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, name); else child.kill(name); } catch {} };
    const terminate = message => { if (failure || settled) return; failure = message; termination = new Promise(resolve => { finishTermination = resolve; }); kill('SIGTERM'); killTimer = setTimeout(() => { kill('SIGKILL'); setTimeout(finishTermination, 100); }, 750); };
    const abort = () => terminate('Command canceled; inspect preserved task state.');
    const timer = setTimeout(() => terminate('Command timed out; inspect local command state.'), timeout);
    const cleanup = () => { settled = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 2000000) terminate('Command exceeded its output limit.'); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); }); // Only a redacted tail reaches Slack.
    child.on('error', error => { cleanup(); reject(new Error(`${path.basename(executable)} could not run (${error.code || 'error'}).`)); });
    child.on('close', async (code, exitSignal) => {
      if (termination) await termination;
      cleanup();
      if (failure) reject(new Error(failure));
      else if (code !== 0) {
        const detail = errorDetail(stderr);
        reject(new Error(`${path.basename(executable)} ${args[0]} failed with ${exitSignal ? `signal ${exitSignal}` : `exit code ${code}`}${detail ? `: ${detail}` : '; inspect local authentication, permissions, or command state.'}`));
      }
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
    // The guard stores resolved paths; compare real paths so a symlinked worktrees root (such as macOS /var -> /private/var) still matches.
    const realWorktree = fs.realpathSync(worktree);
    for (const filename of fs.existsSync(folder) ? fs.readdirSync(folder) : []) {
      if (!filename.endsWith('.json')) continue;
      const statePath = path.join(folder, filename);
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (fs.existsSync(state.worktree) && fs.realpathSync(state.worktree) === realWorktree && state.base_ref === repo.base) {
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
  return pr;
}
const PR_LABELS = [
  { name: 'AI', color: '5319e7', description: 'Created with AI assistance' },
  { name: 'fix-code', color: '0e8a16', description: 'Created by the fix-code skill' },
  { name: 'slack-bridge', color: '1d76db', description: 'Created via the fix-code Slack bridge' }
];
const PR_LABEL_NAMES = PR_LABELS.map(label => label.name);
const labelNamesText = `${PR_LABEL_NAMES.slice(0, -1).join(', ')} and ${PR_LABEL_NAMES.at(-1)}`;
const labelArgs = flag => PR_LABEL_NAMES.flatMap(name => [flag, name]);
// Best effort: create only missing labels (never --force); false on any error, without stderr.
async function ensureLabels(config, task, signal) {
  try {
    const repo = task.repository.github;
    const existing = JSON.parse(await command(config.ghPath, ['label', 'list', '--repo', repo, '--json', 'name', '--limit', '1000'], { cwd: task.worktree, signal }));
    const names = new Set(existing.map(label => label.name));
    for (const label of PR_LABELS) {
      if (names.has(label.name)) continue;
      await command(config.ghPath, ['label', 'create', label.name, '--repo', repo, '--color', label.color, '--description', label.description], { cwd: task.worktree, signal });
    }
    return true;
  } catch { return false; }
}
export async function publishPR(config, task, result, outputDir, signal, { draft = true, draftReason } = {}) {
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
  const text = `This change addresses the authenticated Slack task ${task.id}.\n\n${result.slice(0, 12000)}\n\nBridge verification completed before publication; the mode and review outcome are stated above. Review the evidence and diff before merging.\n${draft ? `\nThis PR is a draft because verification is incomplete: ${draftReason || 'the implementer did not report complete verification'}.\n` : ''}`;
  if (existing) {
    // Followups reuse the PR, so publish this job's mode/review outcome as a comment.
    const note = path.join(outputDir, 'pull-request-update.md');
    fs.writeFileSync(note, text, { mode: 0o600 });
    await command(config.ghPath, ['pr', 'comment', String(existing.url || existing.number), '--repo', task.repository.github, '--body-file', note], { cwd: task.worktree, signal });
    const ref = String(existing.url || existing.number);
    if (draft && existing.isDraft !== true) await command(config.ghPath, ['pr', 'ready', ref, '--repo', task.repository.github, '--undo'], { cwd: task.worktree, signal });
    else if (!draft && existing.isDraft === true) await command(config.ghPath, ['pr', 'ready', ref, '--repo', task.repository.github], { cwd: task.worktree, signal });
    pr = await findPR(config, task, signal);
    if (await ensureLabels(config, task, signal)) {
      await command(config.ghPath, ['pr', 'edit', String(existing.url || existing.number), '--repo', task.repository.github, ...labelArgs('--add-label')], { cwd: task.worktree, signal }).catch(() => {});
    }
  } else {
    const labeled = await ensureLabels(config, task, signal);
    const body = path.join(outputDir, 'pull-request.md');
    fs.writeFileSync(body, labeled ? text : `${text}\nThe ${labelNamesText} labels could not be applied to this PR.\n`, { mode: 0o600 });
    const title = `fix-code: ${task.initialRequest.split('\n')[0]}`.slice(0, 100);
    await command(config.ghPath, ['pr', 'create', '--repo', task.repository.github, '--head', task.branch, '--base', task.repository.baseBranch, ...(draft ? ['--draft'] : []), '--title', title, '--body-file', body, ...(labeled ? labelArgs('--label') : [])], { cwd: task.worktree, signal });
    pr = await findPR(config, task, signal);
  }
  if (!pr || pr.state !== 'OPEN' || pr.isDraft !== draft || !/^https:\/\/github\.com\//.test(pr.url)) throw new Error('PR creation could not be verified. Inspect the branch/forge before retrying.');
  return pr.url;
}
