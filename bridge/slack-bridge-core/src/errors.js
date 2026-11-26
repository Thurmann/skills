export class RunnerError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'RunnerError';
    this.code = code;
  }
}

const SECRET_PATTERNS = [
  // Every Slack token family: xoxb/xoxp/xoxa/xoxr/xoxs plus rotation (xoxe), client (xoxc), cookie (xoxd) and app (xapp) tokens.
  [/x(?:ox[a-z]|app)-[A-Za-z0-9-]+/g, '[redacted]'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{10,}|\bgithub_pat_[A-Za-z0-9_]{10,}/g, '[redacted]'],
  [/\bBearer\s+\S+/gi, 'Bearer [redacted]'],
  [/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*\s*[=:]\s*)\S+/gi, '$1[redacted]'],
  [/\/\/[^\s/@:]+:[^\s/@]+@/g, '//[redacted]@'],
];

export function redactSecrets(text) {
  let result = String(text);
  for (const [pattern, replacement] of SECRET_PATTERNS) result = result.replace(pattern, replacement);
  return result;
}

/**
 * Reduce provider or command error output to a short, redacted detail safe to post in Slack:
 * the last few non-empty lines, with credential-shaped values replaced.
 */
export function errorDetail(text, { maxLines = 5, maxChars = 600 } = {}) {
  if (typeof text !== 'string') return '';
  const detail = redactSecrets(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-maxLines).join(' | '));
  return detail.length > maxChars ? `…${detail.slice(-(maxChars - 1))}` : detail;
}
