import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseEnv } from 'node:util';
import { DEFAULT_PRIORITY, providerNames } from './providers/index.js';

const bool = v => typeof v === 'boolean';
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = v => typeof v === 'string' && v.length > 0;
/** Throws when a bridge profile is malformed; profiles are the only thing that differs between bridge variants. */
export function validateProfile(p) {
  if (!isObject(p)) throw new Error('Bridge profile must be an object.');
  for (const key of ['id', 'configDirName', 'configEnvVar', 'packageDir', 'defaultSkillPath']) if (!nonEmpty(p[key])) throw new Error(`Bridge profile ${key} must be a nonempty string.`);
  if (!isObject(p.github) || !Array.isArray(p.github.modes) || !p.github.modes.length || p.github.modes.some(m => !['user', 'app'].includes(m)) || !p.github.modes.includes('user')) throw new Error('Bridge profile github.modes must list "user" and optionally "app".');
  if (!bool(p.github.tokenFile) || !bool(p.github.forbidRuntimeTokenEnv) || !bool(p.github.requireTokenFile)) throw new Error('Bridge profile github.tokenFile, github.forbidRuntimeTokenEnv and github.requireTokenFile must be booleans.');
  if (p.github.requireTokenFile && !p.github.tokenFile) throw new Error('Bridge profile github.requireTokenFile requires github.tokenFile.');
  if (p.github.modes.includes('app') && !p.github.tokenFile) throw new Error('Bridge profile github mode "app" requires github.tokenFile.');
  if (!isObject(p.routing) || !bool(p.routing.localRoot) || !bool(p.routing.aliases)) throw new Error('Bridge profile routing.localRoot and routing.aliases must be booleans.');
  return p;
}
/** Bind the per-variant parts of configuration (config dir, env var, GitHub and routing capabilities) to a profile. */
export function createConfigApi(profile) {
  validateProfile(profile);
  const defaultSkill = profile.defaultSkillPath;
  const configHome = (env = process.env) => path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), profile.configDirName);
  /** Config lookup: --config, the profile's config env var, ./config.json, then the per-user config directory. */
  const findConfig = (filename, env = process.env, cwd = process.cwd()) => {
    if (filename || env[profile.configEnvVar]) return path.resolve(cwd, filename || env[profile.configEnvVar]);
    const candidates = [path.resolve(cwd, 'config.json'), path.join(configHome(env), 'config.json')];
    const found = candidates.find(file => fs.existsSync(file));
    if (!found) throw new Error(`No config.json found. Looked in: ${candidates.join(', ')}. Run init or pass --config.`);
    return found;
  };
  const loadConfig = filename => loadConfigFor(profile, findConfig(filename), defaultSkill);
  return { configHome, findConfig, loadConfig, defaultSkill };
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
function loadConfigFor(profile, configPath, defaultSkill) {
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
  if (c.githubTokenFile !== undefined && !profile.github.tokenFile) throw new Error(`githubTokenFile is not supported by the ${profile.id} bridge.`);
  if (c.githubAuth !== undefined && profile.github.modes.length === 1 && !profile.github.tokenFile) throw new Error(`githubAuth is not supported by the ${profile.id} bridge.`);
  c.githubAuth ??= 'user';
  if (!['user', 'app'].includes(c.githubAuth)) throw new Error('githubAuth must be "user" or "app".');
  if (!profile.github.modes.includes(c.githubAuth)) throw new Error(`githubAuth "${c.githubAuth}" is not supported by the ${profile.id} bridge.`);
  if (profile.github.requireTokenFile && c.githubTokenFile === undefined) throw new Error(`githubTokenFile is required by the ${profile.id} bridge.`);
  if (c.githubTokenFile !== undefined) c.githubTokenFile = absolute(c.githubTokenFile, directory);
  if (c.githubAuth === 'app' && !c.githubTokenFile) throw new Error('githubAuth "app" requires githubTokenFile (GitHub App installation tokens expire after one hour).');
  if (c.githubTokenFile && c.forwardGitHubAuth === true) throw new Error('forwardGitHubAuth cannot be combined with githubTokenFile; coding runtimes never receive the GitHub token.');
  const hasAliases = c.repositories && typeof c.repositories === 'object' && !Array.isArray(c.repositories) && Object.keys(c.repositories).length > 0;
  c.repositoryRouting ??= { mode: hasAliases ? 'aliases' : 'channel' };
  if (!c.repositoryRouting || typeof c.repositoryRouting !== 'object' || Array.isArray(c.repositoryRouting)) throw new Error('repositoryRouting must be an object.');
  const routing = c.repositoryRouting;
  if (routing.mode === undefined) routing.mode = hasAliases ? 'aliases' : 'channel';
  if (!['channel', 'aliases'].includes(routing.mode)) throw new Error('repositoryRouting.mode must be channel or aliases.');
  if (!profile.routing.aliases) {
    if (routing.mode === 'aliases') throw new Error(`repositoryRouting.mode "aliases" is not supported by the ${profile.id} bridge.`);
    if (hasAliases) throw new Error(`repositories (local checkout aliases) is not supported by the ${profile.id} bridge.`);
  }
  if (routing.allowedOwners === undefined) routing.allowedOwners = [];
  if (!Array.isArray(routing.allowedOwners)) throw new Error('repositoryRouting.allowedOwners must be an array.');
  for (const owner of routing.allowedOwners) {
    if (typeof owner !== 'string' || !githubOwner.test(owner)) throw new Error('repositoryRouting.allowedOwners must contain valid GitHub owner names.');
  }
  routing.cloneRoot = absolute(routing.cloneRoot || path.join(c.stateDir, 'repositories'), directory);
  if (routing.localRoot !== undefined && !profile.routing.localRoot) throw new Error(`repositoryRouting.localRoot is not supported by the ${profile.id} bridge.`);
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
    // When the profile forbids it, coding runtimes never receive Slack or GitHub credentials, so these names are always rejected.
    const forbidden = v => v.startsWith('SLACK_') || (profile.github.forbidRuntimeTokenEnv && (v === 'GH_TOKEN' || v === 'GITHUB_TOKEN'));
    if (!Array.isArray(env) || env.some(v => typeof v !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(v) || forbidden(v))) throw new Error(`runtimes.${runtime}.env must list environment variable names (not SLACK_*${profile.github.forbidRuntimeTokenEnv ? ', GH_TOKEN or GITHUB_TOKEN' : ''}).`);
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
