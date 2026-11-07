import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const id = (value, pattern, label) => {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid ${label}; replace example values in config.json.`);
  return value;
};
const absolute = (value, directory) => {
  if (typeof value !== 'string' || !value) throw new Error('Configured paths must be nonempty strings.');
  return path.resolve(directory, value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value);
};
const githubOwner = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
export function loadConfig(filename = process.env.FIX_CODE_CONFIG || './config.json') {
  const configPath = path.resolve(filename);
  const c = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const directory = path.dirname(configPath);
  id(c.teamId, /^T[A-Z0-9]+$/, 'Slack team ID');
  if (!Array.isArray(c.allowedUsers) || !c.allowedUsers.length) throw new Error('allowedUsers must be an explicit nonempty allowlist.');
  c.allowedUsers.forEach(v => id(v, /^[UW][A-Z0-9]+$/, 'allowedUsers'));
  if (!Array.isArray(c.allowedChannels) || !c.allowedChannels.length) throw new Error('allowedChannels must be an explicit nonempty allowlist.');
  if (c.allowedChannels.includes('*')) {
    if (c.allowedChannels.length !== 1) throw new Error('allowedChannels wildcard must be the sole entry.');
  } else {
    c.allowedChannels.forEach(v => id(v, /^[CG][A-Z0-9]+$/, 'allowedChannels'));
  }
  c.operators ??= [];
  if (!Array.isArray(c.operators) || c.operators.some(v => !c.allowedUsers.includes(v))) throw new Error('operators must be a subset of allowedUsers.');
  c.runtime ??= 'codex';
  if (!['codex', 'claude'].includes(c.runtime)) throw new Error('runtime must be codex or claude.');
  c.skillPath = absolute(c.skillPath || './skills/fix-code', directory);
  if (!fs.existsSync(path.join(c.skillPath, 'SKILL.md')) || !fs.existsSync(path.join(c.skillPath, 'scripts/git_guard.py'))) throw new Error('The installed fix-code skill and Git helper are required.');
  c.stateDir = absolute(c.stateDir || './state', directory);
  c.timeoutMs ??= 1800000;
  c.maxRepairRounds ??= 2;
  if (!Number.isInteger(c.timeoutMs) || c.timeoutMs < 1000 || c.timeoutMs > 86400000) throw new Error('timeoutMs must be between 1000 and 86400000.');
  if (!Number.isInteger(c.maxRepairRounds) || c.maxRepairRounds < 0 || c.maxRepairRounds > 3) throw new Error('maxRepairRounds must be 0..3.');
  if (typeof c.allowNetwork !== 'boolean') throw new Error('Set allowNetwork explicitly to true or false.');
  c.codexPath ||= 'codex'; c.claudePath ||= 'claude'; c.pythonPath ||= 'python3'; c.ghPath ||= 'gh';
  const hasAliases = c.repositories && typeof c.repositories === 'object' && !Array.isArray(c.repositories) && Object.keys(c.repositories).length > 0;
  c.repositoryRouting ??= { mode: hasAliases ? 'aliases' : 'channel' };
  if (!c.repositoryRouting || typeof c.repositoryRouting !== 'object' || Array.isArray(c.repositoryRouting)) throw new Error('repositoryRouting must be an object.');
  const routing = c.repositoryRouting;
  if (routing.mode === undefined) routing.mode = hasAliases ? 'aliases' : 'channel';
  if (!['channel', 'aliases'].includes(routing.mode)) throw new Error('repositoryRouting.mode must be channel or aliases.');
  if (routing.allowedOwners === undefined) routing.allowedOwners = [];
  if (!Array.isArray(routing.allowedOwners)) throw new Error('repositoryRouting.allowedOwners must be an array.');
  for (const owner of routing.allowedOwners) {
    if (typeof owner !== 'string' || !githubOwner.test(owner)) throw new Error('repositoryRouting.allowedOwners must contain valid GitHub owner names.');
  }
  routing.cloneRoot = absolute(routing.cloneRoot || path.join(c.stateDir, 'repositories'), directory);
  if (routing.localRoot !== undefined) {
    routing.localRoot = absolute(routing.localRoot, directory);
    if (!fs.existsSync(routing.localRoot) || !fs.statSync(routing.localRoot).isDirectory()) throw new Error('repositoryRouting.localRoot must be an existing directory.');
    routing.localRoot = fs.realpathSync(routing.localRoot);
  }
  const forbiddenRoots = [path.parse(routing.cloneRoot).root, os.homedir(), c.skillPath, c.stateDir, directory];
  if (forbiddenRoots.some(root => path.resolve(root) === routing.cloneRoot)) throw new Error('repositoryRouting.cloneRoot cannot be a filesystem, home, skill, state, or source root.');
  if (routing.channelOwners === undefined) routing.channelOwners = {};
  if (!routing.channelOwners || typeof routing.channelOwners !== 'object' || Array.isArray(routing.channelOwners)) throw new Error('repositoryRouting.channelOwners must be an object.');
  for (const [channel, owner] of Object.entries(routing.channelOwners)) {
    if (!/^[CG][A-Z0-9]+$/.test(channel)) throw new Error(`Invalid repositoryRouting channel ID: ${channel}.`);
    if (typeof owner !== 'string' || !githubOwner.test(owner)) throw new Error(`Invalid GitHub owner hint for channel ${channel}.`);
    if (routing.allowedOwners.length && !routing.allowedOwners.some(allowed => allowed.toLowerCase() === owner.toLowerCase())) {
      throw new Error(`GitHub owner hint for channel ${channel} is not in allowedOwners.`);
    }
  }
  c.repositories = c.repositories && typeof c.repositories === 'object' && !Array.isArray(c.repositories) ? c.repositories : {};
  if (routing.mode === 'aliases') {
    if (!Object.keys(c.repositories).length) throw new Error('At least one repository alias is required in aliases mode.');
    for (const [alias, repo] of Object.entries(c.repositories)) {
      id(alias, /^[a-zA-Z0-9_-]+$/, 'repository alias');
      if (!repo || typeof repo !== 'object' || Array.isArray(repo)) throw new Error(`Invalid repository configuration for ${alias}.`);
      repo.path = absolute(repo.path, directory);
      if (!fs.existsSync(repo.path)) throw new Error(`Repository path missing for ${alias}; provision it locally first.`);
      for (const key of ['base', 'baseBranch', 'remote']) id(repo[key], /^(?!-)[a-zA-Z0-9._\/-]+$/, `${alias}.${key}`);
      id(repo.github, /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, `${alias}.github`);
      if (repo.baseBranch.startsWith('fix-code/') && repo.baseBranch !== 'fix-code/base') throw new Error('A task branch cannot be the configured base.');
    }
  } else {
    c.repositories = {};
  }
  for (const runtime of ['codex', 'claude']) {
    const defaults = c.models?.[runtime];
    if (!defaults) { if (runtime === c.runtime) throw new Error(`models.${runtime} is required.`); continue; }
    const allowed = c.allowedModels?.[runtime];
    if (!Array.isArray(allowed) || !allowed.length) throw new Error(`allowedModels.${runtime} is required.`);
    allowed.forEach(v => id(v, /^(?!-)[a-zA-Z0-9._:/-]+$/, 'model ID'));
    for (const role of ['architect', 'implementer', 'reviewer']) if (!allowed.includes(defaults[role])) throw new Error(`${runtime}.${role} is not in its model allowlist.`);
  }
  c.configPath = configPath;
  return c;
}
export function resolveModels(config, runtime, overrides = {}, previous) {
  const defaults = previous || config.models[runtime];
  if (!defaults || !config.allowedModels[runtime]) throw new Error(`Runtime ${runtime} is not configured.`);
  const selected = {};
  for (const role of ['architect', 'implementer', 'reviewer']) {
    selected[role] = overrides[role] || overrides.all || defaults[role];
    if (!config.allowedModels[runtime].includes(selected[role])) throw new Error(`Model for ${role} is not allowlisted; update local configuration after validating runtime availability.`);
  }
  return selected;
}
