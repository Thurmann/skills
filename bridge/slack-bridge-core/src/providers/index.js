import claude from './claude.js';
import codex from './codex.js';
import gemini from './gemini.js';
import opencode from './opencode.js';

export const PROVIDERS = new Map([claude, codex, gemini, opencode].map((p) => [p.name, p]));
export const DEFAULT_PRIORITY = ['claude', 'codex', 'gemini', 'opencode'];

export const providerNames = () => [...PROVIDERS.keys()];

export function getProvider(name) {
  const provider = PROVIDERS.get(name);
  if (!provider) throw new Error(`runtime must be one of: ${providerNames().join(', ')}`);
  return provider;
}
