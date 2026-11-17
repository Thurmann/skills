import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseEnv } from 'node:util';
import { DEFAULT_PRIORITY, providerNames } from './providers/index.js';

export const defaultSkill = path.resolve(import.meta.dirname, '../../skills/fix-code');
export const configHome =(env = process.env) => path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'fix-code-bridge');
/** Config lookup: --config, FIX_CODE_CONFIG, ./config.json, then the per-user config directory. */
export function findConfig(filename, env = process.env, cwd = process.cwd()) {
  if (filename || env.FIX_CODE_CONFIG) return path.resolve(cwd, filename || env.FIX_CODE_CONFIG);
  const candidates = [path.resolve(cwd, 'config.json'), path.join(configHome(env), 'config.json')];
  const found = candidates.find(file => fs.existsSync(file));
  if (!found) throw new Error(`No config.json found. Looked in: ${candidates.join(', ')}. Run init or pass --config.`);
  return found;
}
/** Load the .env beside the config; variables that are already set win. */
export function loadEnvBeside(configPath, env = process.env) {
  const file = path.join(path.dirname(configPath), '.env');
  if (!fs.existsSync(file)) return null;
  for (const [key, value] of Object.entries(parseEnv(fs.readFileSync(file, 'utf8')))) env[key] ??= value;
  return file;
}

const id = (value, pattern, label) => {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid ${label}; replace example values in config.json.`);
  return value;
};
const absolute = (value, directory) => {
  if (typeof value !== 'string' || !value) throw new Error('Configured paths must be nonempty strings.');
  return path.resolve(directory, value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value);
};
const githubOwner = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
export function loadConfig(filename) {
  const configPath = findConfig(filename);
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
  const names = providerNames();
  c.runtimeExplicit = Boolean(c.runtime);
  if (c.runtimeExplicit && !names.includes(c.runtime)) throw new Error(`runtime must be one of: ${names.join(', ')}.`);
  c.skillPath = c.skillPath ? absolute(c.skillPath, directory) : defaultSkill;
  if (!fs.existsSync(path.join(c.skillPath, 'SKILL.md')) || !fs.existsSync(path.join(c.skillPath, 'scripts/git_guard.py'))) throw new Error('The installed fix-code skill and Git helper are required.');
  c.stateDir = absolute(c.stateDir || './state', directory);
  c.timeoutMs ??= 1800000;
  c.maxRepairRounds ??= 2;
  c.statusIntervalMs ??= 300000;
  if (!Number.isInteger(c.statusIntervalMs) || c.statusIntervalMs < 60000 || c.statusIntervalMs > 86400000) throw new Error('statusIntervalMs must be between 60000 and 86400000.');
  if (!Number.isInteger(c.timeoutMs) || c.timeoutMs < 1000 || c.timeoutMs > 86400000) throw new Error('timeoutMs must be between 1000 and 86400000.');
  if (!Number.isInteger(c.maxRepairRounds) || c.maxRepairRounds < 0 || c.maxRepairRounds > 3) throw new Error('maxRepairRounds must be 0..3.');
  if (typeof c.allowNetwork !== 'boolean') throw new Error('Set allowNetwork explicitly to true or false.');
  c.pythonPath ||= 'python3'; c.ghPath ||= 'gh';
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
  const input = c.runtimes ?? {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('runtimes must be an object.');
  for (const name of Object.keys(input)) if (!names.includes(name)) throw new Error(`Unknown runtime in runtimes: ${name}; use one of: ${names.join(', ')}.`);
  c.runtimes = {}; c.models ??= {}; c.allowedModels ??= {};
  for (const runtime of names) {
    const entry = input[runtime] ?? {};
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`runtimes.${runtime} must be an object.`);
    const defaults = entry.models ?? c.models[runtime];
    if (!defaults) continue;
    defaults.precheck ??= defaults.implementer;
    const allowed = entry.allowedModels ?? c.allowedModels[runtime];
    if (!Array.isArray(allowed) || !allowed.length) throw new Error(`allowedModels.${runtime} is required.`);
    allowed.forEach(v => id(v, /^(?!-)[a-zA-Z0-9._:/-]+$/, 'model ID'));
    for (const role of ['precheck', 'architect', 'implementer', 'reviewer']) if (!allowed.includes(defaults[role])) throw new Error(`${runtime}.${role} is not in its model allowlist.`);
    const env = entry.env ?? [];
    if (!Array.isArray(env) || env.some(v => typeof v !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(v) || v.startsWith('SLACK_'))) throw new Error(`runtimes.${runtime}.env must list environment variable names (not SLACK_*).`);
    const bin = entry.path ?? c[`${runtime}Path`] ?? runtime;
    if (typeof bin !== 'string' || !bin) throw new Error('Configured paths must be nonempty strings.');
    c.runtimes[runtime] = { path: bin, models: defaults, allowedModels: allowed, env };
    c.models[runtime] = defaults; c.allowedModels[runtime] = allowed;
  }
  const configured = Object.keys(c.runtimes);
  if (!configured.length) throw new Error('Configure at least one runtime under runtimes (or models/allowedModels).');
  if (c.runtimeExplicit && !c.runtimes[c.runtime]) throw new Error(`models.${c.runtime} is required.`);
  for (const runtime of names) c[`${runtime}Path`] = c.runtimes[runtime]?.path ?? c[`${runtime}Path`] ?? runtime;
  c.runtimePriority ??= [...DEFAULT_PRIORITY];
  if (!Array.isArray(c.runtimePriority) || c.runtimePriority.some(v => !names.includes(v)) || new Set(c.runtimePriority).size !== c.runtimePriority.length) throw new Error(`runtimePriority must be unique names from: ${names.join(', ')}.`);
  c.runtimePriority.push(...names.filter(v => c.runtimes[v] && !c.runtimePriority.includes(v)));
  c.configPath = configPath;
  return c;
}
export function resolveModels(config, runtime, overrides = {}, previous) {
  const defaults = previous || config.models[runtime];
  if (!defaults || !config.allowedModels[runtime]) throw new Error(`Runtime ${runtime} is not configured.`);
  const selected = {};
  for (const role of ['precheck', 'architect', 'implementer', 'reviewer']) {
    selected[role] = overrides[role] || overrides.all || (role === 'precheck' ? defaults.precheck || defaults.implementer : defaults[role]);
    if (!config.allowedModels[runtime].includes(selected[role])) throw new Error(`Model for ${role} is not allowlisted; update local configuration after validating runtime availability.`);
  }
  return selected;
}
/** Pick the default runtime: override > explicit config.runtime > first configured, available provider in priority order. */
export async function selectDefaultRuntime(config, { override, isAvailable = async () => true } = {}) {
  const pinned = override || (config.runtimeExplicit ? config.runtime : undefined);
  const candidates = config.runtimePriority.filter(name => config.runtimes[name]);
  const available = [];
  for (const name of candidates) if (await isAvailable(name)) available.push(name);
  config.availableRuntimes = available;
  if (pinned) {
    if (!config.runtimes[pinned]) throw new Error(`Runtime ${pinned} is not configured.`);
    if (!available.includes(pinned)) throw new Error(`Runtime ${pinned} CLI is not available on this host.`);
    return config.runtime = pinned;
  }
  if (!available.length) throw new Error('No configured provider CLI is available.');
  return config.runtime = available[0];
}
