#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import { loadConfig, selectDefaultRuntime, configHome, findConfig, loadEnvBeside } from './config.js';
import { Store } from './store.js';
import { createRunner } from './runner.js';
import { getProvider, providerNames } from './providers/index.js';
import { Bridge, processIdentity } from './bridge.js';
import { command, validateRepository, configureGitHubAuth, checkGitHubTokenFile } from './git.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function mkdirPrivate(folder) { fs.mkdirSync(folder, { recursive: true, mode: 0o700 }); fs.chmodSync(folder, 0o700); }
const safeLogger = {
  debug() {}, info() {}, warn() { console.warn('Slack client warning (details suppressed to protect credentials).'); },
  error() { console.error('Slack client error (details suppressed; check connection/app configuration).'); },
  getLevel() { return 'error'; }, setLevel() {}
};
const available = config => name => command(config.runtimes[name].path, ['--version']).then(() => true, () => false);
// An installed CLI without models/allowedModels is skipped by config loading; say so instead of staying silent.
async function unconfiguredInstalled(config) {
  const found = [];
  for (const name of providerNames()) {
    if (!config.runtimes[name] && await command(config[`${name}Path`], ['--version']).then(() => true, () => false)) found.push(name);
  }
  return found;
}
const unconfiguredWarning = name => `${name} CLI is installed but not configured; add models.${name} and allowedModels.${name} (or runtimes.${name}) to config.json to use it.`;
async function doctor(config, override) {
  const checks = [];
  const check = async (name, operation, required = true) => {
    try { await operation(); checks.push({ check: name, ok: true }); }
    catch (error) { checks.push(required ? { check: name, ok: false, reason: error.message } : { check: name, ok: true, unavailable: error.message }); }
  };
  await check('fix-code skill', async () => { if (!fs.existsSync(path.join(config.skillPath, 'SKILL.md'))) throw new Error('Skill missing.'); });
  await check('Python Git helper', () => command(config.pythonPath, [path.join(config.skillPath, 'scripts/git_guard.py'), '--help']));
  // Only one usable provider is needed; the others are informational.
  const usable = [];
  for (const runtime of Object.keys(config.runtimes)) {
    let ok = true;
    for (const { name, args } of getProvider(runtime).doctorChecks()) await check(`${runtime} ${name}`, () => command(config.runtimes[runtime].path, args).catch(error => { ok = false; throw error; }), false);
    if (ok) usable.push(runtime);
  }
  for (const name of await unconfiguredInstalled(config)) checks.push({ check: `${name} configuration`, ok: true, warning: unconfiguredWarning(name) });
  if (override) checks.push(usable.includes(override) ? { check: `requested runtime ${override}`, ok: true } : { check: `requested runtime ${override}`, ok: false, reason: `Runtime ${override} is not configured or not usable on this host.` });
  else checks.push(usable.length ? { check: 'at least one provider usable', ok: true, usable } : { check: 'at least one provider usable', ok: false, reason: 'No configured provider CLI is usable on this host.' });
  try { checks.push({ check: `default runtime: ${await selectDefaultRuntime(config, { override, isAvailable: async name => usable.includes(name) })}`, ok: true }); }
  catch (error) { if (!override && usable.length) checks.push({ check: 'default runtime', ok: true, warning: `${error.message} start will fail unless you pass --runtime ${usable.join('|')} or change "runtime" in config.json.` }); }
  if (config.githubTokenFile) await check('GitHub token file', () => checkGitHubTokenFile(config.githubTokenFile, { maxAgeMs: config.githubAuth === 'app' ? 55 * 60000 : undefined }));
  if (config.githubAuth === 'app') await check('GitHub App installation access', () => command(config.ghPath, ['api', '--hostname', 'github.com', '--method', 'GET', '/installation/repositories?per_page=1', '--jq', '.total_count']));
  else await check('GitHub CLI authentication', () => command(config.ghPath, ['auth', 'status']));
  for (const [alias, repo] of Object.entries(config.repositories)) await check(`repository ${alias}`, () => validateRepository(repo));
  checks.push({ check: 'Slack bot token configured', ok: /^xoxb-/.test(process.env.SLACK_BOT_TOKEN || '') });
  checks.push({ check: 'Slack app token configured', ok: /^xapp-/.test(process.env.SLACK_APP_TOKEN || '') });
  console.log(JSON.stringify({ ok: checks.every(c => c.ok), checks, note: 'No Slack messages or model calls were made. Model availability is validated by the runtime when invoked; no fallback is performed.' }, null, 2));
  if (!checks.every(c => c.ok)) process.exitCode = 1;
}
async function start(config, override) {
  if (!/^xoxb-/.test(process.env.SLACK_BOT_TOKEN || '') || !/^xapp-/.test(process.env.SLACK_APP_TOKEN || '')) throw new Error('Set Slack bot/app tokens locally in .env. Never paste them into chat.');
  await selectDefaultRuntime(config, { override, isAvailable: available(config) });
  console.log(`Default runtime: ${config.runtime}; available: ${config.availableRuntimes.join(', ')}`);
  for (const name of await unconfiguredInstalled(config)) console.warn(`Warning: ${unconfiguredWarning(name)}`);
  mkdirPrivate(config.stateDir);
  let release = () => {};
  let store, socket, bridge, timers = [];
  try {
    store = new Store(path.join(config.stateDir, 'bridge.sqlite'));
    const token = randomUUID();
    store.claimInstance({ pid: process.pid, identity: processIdentity(process.pid), token }, previous => processIdentity(previous.pid) === previous.identity && previous.identity !== null);
    release = () => store.releaseInstance(token);
    const client = new WebClient(process.env.SLACK_BOT_TOKEN, { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, logger: safeLogger });
    const auth = await client.auth.test();
    if (auth.team_id !== config.teamId || !auth.user_id) throw new Error('Slack bot token belongs to a different configured workspace or has no bot identity.');
    bridge = new Bridge(config, store, createRunner(config), { post: payload => client.chat.postMessage(payload), channelInfo: channel => client.conversations.info({ channel }) }, auth.user_id);
    bridge.recover();
    socket = new SocketModeClient({ appToken: process.env.SLACK_APP_TOKEN, logger: safeLogger });
    socket.on('app_mention', async ({ body, ack }) => {
      try { await bridge.receive(body); await ack(); }
      catch { console.error('Intake persistence failed; event was not acknowledged so Slack can redeliver.'); }
    });
    socket.on('error', () => console.error('Slack Socket Mode connection error; inspect app setup/network.'));
    await socket.start();
    timers = [setInterval(() => bridge.tick().catch(() => console.error('Worker error; task state is preserved.')), 750), setInterval(() => bridge.flushOutbox().catch(() => console.error('Reply persistence error; inspect local outbox.')), 1000)];
    console.log('Fix Code Slack bridge connected. Only configured users/channels are accepted; repository routing follows local configuration.');
    let closing = false;
    const shutdown = async () => {
      if (closing) return; closing = true;
      timers.forEach(clearInterval);
      await bridge.stop();
      await socket.disconnect();
      const deadline = Date.now() + 12000;
      while (bridge.working && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      if (bridge.working) { console.error('Shutdown timed out; inspect preserved runner state before restarting.'); process.exitCode = 1; }
      if (!bridge.working) { release(); store.close(); }
    };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  } catch (error) {
    timers.forEach(clearInterval);
    if (socket) await socket.disconnect().catch(() => {});
    release(); if (store) store.close();
    throw new Error(error.message?.includes('configured') || error.message?.includes('runner') ? error.message : 'Bridge startup failed; check local authentication, app scopes, workspace IDs, and interrupted-run state.');
  }
}
async function main() {
  const args = process.argv.slice(2);
  const action = args.shift() || 'help';
  const configIndex = args.indexOf('--config');
  let filename;
  if (configIndex >= 0) { filename = args[configIndex + 1]; if (!filename) throw new Error('--config needs a path.'); args.splice(configIndex, 2); }
  const runtimeIndex = args.indexOf('--runtime');
  let runtimeOverride;
  if (runtimeIndex >= 0) { runtimeOverride = args[runtimeIndex + 1]; if (!runtimeOverride) throw new Error('--runtime needs a name.'); args.splice(runtimeIndex, 2); }
  if (action === 'help') {
    console.log('Commands: init | doctor | start | status | outbox [retry <id> --confirmed-not-delivered]\nOptional: --config /path/to/config.json (default: ./config.json, then ~/.config/fix-code-company-bridge/config.json); --runtime <name> (start, doctor) overrides the default runtime. See README.md for Slack setup.'); return;
  }
  if (action === 'init') {
    const directory = filename ? path.dirname(path.resolve(filename)) : configHome();
    mkdirPrivate(directory);
    for (const [source, destination] of [['config.example.json', filename ? path.basename(filename) : 'config.json'], ['.env.example', '.env']]) {
      const target = path.join(directory, destination);
      if (fs.existsSync(target)) { console.log(`Preserved existing ${target}`); continue; }
      fs.writeFileSync(target, fs.readFileSync(path.join(project, source)), { flag: 'wx', mode: 0o600 });
      console.log(`Created ${target}; edit placeholders locally.`);
    }
    return;
  }
  const configPath = findConfig(filename);
  loadEnvBeside(configPath);
  const config = loadConfig(configPath);
  configureGitHubAuth(config);
  if (action === 'doctor') return doctor(config, runtimeOverride);
  if (action === 'start') return start(config, runtimeOverride);
  if (action === 'status' || action === 'outbox') {
    const database = path.join(config.stateDir, 'bridge.sqlite');
    if (!fs.existsSync(database)) { console.log('No local task database yet.'); return; }
    const store = new Store(database);
    try {
      if (action === 'status') console.log(JSON.stringify(store.listTasks().map(t => ({ id: t.id, repo: t.repository?.github || t.repoAlias || 'channel resolution pending', channelName: t.channelName, status: t.status, stage: t.stage, branch: t.branch, prUrl: t.prUrl })), null, 2));
      else if (args[0] === 'retry') {
        const instance = store.getInstance();
        if (instance && instance.identity && processIdentity(instance.pid) === instance.identity) throw new Error('Stop the bridge before manually reconciling replies.');
        if (!args.includes('--confirmed-not-delivered')) throw new Error('Inspect the Slack thread, then pass --confirmed-not-delivered to explicitly retry.');
        const entry = store.getOutbox(args[1]);
        if (!entry || !['uncertain', 'failed'].includes(entry.status)) throw new Error('Only failed/uncertain replies can be manually retried.');
        entry.status = 'pending'; entry.attempts = 0; entry.nextAttemptAt = 0; store.saveOutbox(entry); console.log('Reply queued for the next bridge start.');
      } else console.log(JSON.stringify(store.listOutbox().filter(e => e.status !== 'sent').map(e => ({ id: e.id, status: e.status, attempts: e.attempts, error: e.error })), null, 2));
    } finally { store.close(); }
    return;
  }
  throw new Error('Unknown command. Run node src/cli.js help.');
}
main().catch(error => { console.error(error.message?.replace(/xox[baprs]-[A-Za-z0-9-]+|xapp-[A-Za-z0-9-]+/g, '[redacted]') || 'Command failed.'); process.exitCode = 1; });
