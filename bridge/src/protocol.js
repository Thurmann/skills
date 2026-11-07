const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const FORBIDDEN_INPUT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const MAX_REQUEST = 16000;
const MAX_INPUT = 16512;

export function safeText(value, maxLength = 4000) {
  const clean = String(value ?? '').replace(ANSI, '').replace(CONTROL, '');
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
}

export function escapeSlack(value, maxLength = 4000) {
  return safeText(value, maxLength).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fail(message) {
  throw new Error(message);
}

function parseModels(options, allowRepo, allowRuntime) {
  const parsed = { models: {} };
  const seen = new Set();
  for (const option of options) {
    const match = /^(repo|runtime|model|architect_model|implementer_model|reviewer_model)=(.*)$/.exec(option);
    if (!match) fail(`Unknown argument: ${option}`);
    const [, key, value] = match;
    if (seen.has(key)) fail(`Duplicate option: ${key}`);
    seen.add(key);
    if (key === 'repo') {
      if (!allowRepo) fail('followup does not accept repo');
      if (!/^[A-Za-z0-9_-]+$/.test(value)) fail('repo must be a valid alias');
      parsed.repo = value;
    } else if (key === 'runtime') {
      if (!allowRuntime) fail('followup does not accept runtime');
      if (!['codex', 'claude'].includes(value)) fail('runtime must be codex or claude');
      parsed.runtime = value;
    } else {
      if (!value || /^-/.test(value) || /\s|[\u0000-\u001f\u007f-\u009f]/.test(value)) {
        fail(`${key} must be a non-empty id without whitespace or control characters`);
      }
      parsed.models[{ model: 'all', architect_model: 'architect', implementer_model: 'implementer', reviewer_model: 'reviewer' }[key]] = value;
    }
  }
  return parsed;
}

function requestParts(rest, command) {
  const delimiter = /(?:^|\s)--(?=\s)/.exec(rest);
  if (!delimiter) fail(`${command} requires -- followed by a request`);
  const optionsText = rest.slice(0, delimiter.index).trim();
  const request = rest.slice(delimiter.index + delimiter[0].length).trim();
  if (!request) fail('Request cannot be empty');
  if (request.length > MAX_REQUEST) fail(`Request exceeds ${MAX_REQUEST} characters`);
  return { options: optionsText ? optionsText.split(/\s+/) : [], request };
}

/** Parse a bot mention command. Returns null for ordinary non-command messages. */
export function parseCommand(text, botUserId, options = {}) {
  if (typeof text !== 'string') return null;
  if (text.length > MAX_INPUT) fail(`Command exceeds ${MAX_INPUT} characters`);
  if (FORBIDDEN_INPUT_CONTROL.test(text)) fail('Command contains a forbidden control character');
  if (typeof botUserId !== 'string' || !botUserId) throw new TypeError('botUserId is required');
  const mention = `<@${botUserId}>`;
  if (!text.startsWith(mention)) {
    // Any other mention is ordinary conversation; a partial mention of this bot is malformed.
    if (text.startsWith(`<@${botUserId}`)) fail('Malformed bot mention');
    return null;
  }
  if (text.length === mention.length || !/\s/.test(text[mention.length])) {
    fail('Bot mention must be followed by whitespace and a command');
  }
  const commandText = text.slice(mention.length).trimStart();
  if (!commandText) fail('Missing command after bot mention');
  const firstSpace = commandText.search(/\s/);
  const command = firstSpace < 0 ? commandText : commandText.slice(0, firstSpace);
  const rest = firstSpace < 0 ? '' : commandText.slice(firstSpace).trimStart();

  if (command === 'run' || command === 'followup') {
    const { options: argumentsList, request } = requestParts(rest, command);
    const parsed = parseModels(argumentsList, command === 'run', command === 'run');
    if (command === 'run' && options.requireRepo !== false && !parsed.repo) fail('run requires repo=<alias>');
    return { command, ...(parsed.repo ? { repo: parsed.repo } : {}), ...(parsed.runtime ? { runtime: parsed.runtime } : {}), models: parsed.models, request };
  }
  if (!['status', 'cancel', 'retry', 'help'].includes(command)) fail(`Unknown command: ${command}`);
  if (rest) fail(`${command} does not accept arguments`);
  return { command };
}

export default parseCommand;
