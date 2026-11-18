import assert from 'node:assert/strict';
import test from 'node:test';
import { errorDetail, redactSecrets } from '../src/errors.js';

test('errorDetail keeps the last lines and redacts credential-shaped values', () => {
  const text = ['line 1', '', 'line 2', 'OPENAI_API_KEY=sk-abcdefghijklmnop', 'auth: Bearer abc.def', 'https://user:pass@github.com/x', 'token ghp_abcdefghijklmnopqrst xoxb-1-2'].join('\n');
  assert.equal(errorDetail(text), 'line 2 | OPENAI_API_KEY=[redacted] | auth: Bearer [redacted] | https://[redacted]@github.com/x | token [redacted] [redacted]');
  assert.equal(errorDetail(text, { maxLines: 1 }), 'token [redacted] [redacted]');
});

test('errorDetail bounds its length and ignores non-strings', () => {
  assert.equal(errorDetail('x'.repeat(1000), { maxChars: 10 }), '…xxxxxxxxx');
  assert.equal(errorDetail(undefined), '');
  assert.equal(redactSecrets('GITHUB_TOKEN: abc'), 'GITHUB_TOKEN: [redacted]');
});
