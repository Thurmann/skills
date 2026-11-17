import claude from './claude.js';
import codex from './codex.js';

export const PROVIDERS = new Map([claude, codex].map((p) => [p.name, p]));
export const DEFAULT_PRIORITY = ['claude', 'codex'];

export const providerNames = () => [...PROVIDERS.keys()];

export function getProvider(name) {
  const provider = PROVIDERS.get(name);
  if (!provider) throw new Error(`runtime must be one of: ${providerNames().join(', ')}`);
  return provider;
}
