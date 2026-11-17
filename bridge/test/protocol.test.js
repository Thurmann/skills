import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeSlack, parseCommand, safeText } from '../src/protocol.js';

const BOT = 'U123ABC';

test('parses run and followup options only before the delimiter', () => {
  assert.deepEqual(parseCommand('<@U123ABC> run repo=demo runtime=claude model=opus architect_model=sonnet -- please use model=ignored and repo=evil', BOT), {
    command: 'run', repo: 'demo', runtime: 'claude',
    models: { all: 'opus', architect: 'sonnet' },
    request: 'please use model=ignored and repo=evil',
  });
  assert.deepEqual(parseCommand('<@U123ABC> followup reviewer_model=review-v2 -- continue the task', BOT), {
    command: 'followup', models: { reviewer: 'review-v2' }, request: 'continue the task',
  });
  assert.deepEqual(parseCommand('<@U123ABC> followup -- continue without model options', BOT), {
    command: 'followup', models: {}, request: 'continue without model options',
  });
});

test('parses mode and precheck_model on run and followup', () => {
  assert.deepEqual(parseCommand('<@U123ABC> run repo=demo mode=medium precheck_model=cheap -- build it', BOT), {
    command: 'run', repo: 'demo', mode: 'medium', models: { precheck: 'cheap' }, request: 'build it',
  });
  assert.deepEqual(parseCommand('<@U123ABC> followup mode=advanced precheck_model=cheap -- continue', BOT), {
    command: 'followup', mode: 'advanced', models: { precheck: 'cheap' }, request: 'continue',
  });
});

test('rejects invalid and duplicate mode values', () => {
  assert.throws(() => parseCommand('<@U123ABC> run repo=x mode=expert -- do it', BOT), /mode must be simple, medium, or advanced/);
  assert.throws(() => parseCommand('<@U123ABC> followup mode=simple mode=simple -- do it', BOT), /Duplicate option: mode/);
});

test('channel routing can omit the repo option while preserving model options and inert request text', () => {
  assert.throws(() => parseCommand('<@U123ABC> run -- build it', BOT), /requires repo/);
  assert.deepEqual(parseCommand('<@U123ABC> run model=small reviewer_model=strong -- implement using repo=evil model=ignored', BOT, { requireRepo: false }), {
    command: 'run',
    models: { all: 'small', reviewer: 'strong' },
    request: 'implement using repo=evil model=ignored',
  });
  assert.deepEqual(parseCommand('<@U123ABC> run repo=legacy -- request', BOT, { requireRepo: false }), {
    command: 'run', repo: 'legacy', models: {}, request: 'request',
  });
});

test('requires an anchored actual bot mention and distinguishes ordinary messages', () => {
  assert.equal(parseCommand('hello <@U123ABC> status', BOT), null);
  assert.equal(parseCommand('<@U999> status', BOT), null);
  assert.throws(() => parseCommand('<@U123ABC', BOT), /Malformed bot mention/);
  assert.throws(() => parseCommand('<@U123ABC>status', BOT), /followed by whitespace/);
  assert.throws(() => parseCommand('<@U123ABC>', BOT), /followed by whitespace/);
});

test('rejects unknown, duplicate, misplaced, and invalid arguments', () => {
  for (const text of [
    '<@U123ABC> run repo=x nonsense -- do it',
    '<@U123ABC> run repo=x repo=y -- do it',
    '<@U123ABC> run repo=x model=one model=two -- do it',
    '<@U123ABC> run repo=x runtime=bad -- do it',
    '<@U123ABC> run repo=x model=-unsafe -- do it',
    '<@U123ABC> followup repo=x -- do it',
    '<@U123ABC> followup runtime=codex -- do it',
    '<@U123ABC> status now',
  ]) assert.throws(() => parseCommand(text, BOT));
});

test('accepts |, em dash and en dash as the separator like --', () => {
  const expected = parseCommand('<@U123ABC> run repo=demo mode=simple -- fix the bug', BOT);
  assert.deepEqual(expected, { command: 'run', repo: 'demo', mode: 'simple', models: {}, request: 'fix the bug' });
  for (const sep of ['|', '\u2014', '\u2013']) {
    assert.deepEqual(parseCommand(`<@U123ABC> run repo=demo mode=simple ${sep} fix the bug`, BOT), expected);
  }
});

test('keeps later separator-like text inside the request verbatim', () => {
  assert.deepEqual(parseCommand('<@U123ABC> run repo=demo mode=simple | fix a|b -- c', BOT), {
    command: 'run', repo: 'demo', mode: 'simple', models: {}, request: 'fix a|b -- c',
  });
});

test('does not treat dashes inside words or a colon as the separator', () => {
  assert.throws(() => parseCommand('<@U123ABC> run repo=demo foo\u2014bar', BOT), /requires \|/);
  assert.throws(() => parseCommand('<@U123ABC> run repo=demo mode=simple: fix', BOT), /requires \|/);
});

test('rejects missing, empty, and oversized requests', () => {
  assert.throws(() => parseCommand('<@U123ABC> run repo=x', BOT), /requires \|/);
  assert.throws(() => parseCommand('<@U123ABC> run repo=x --   ', BOT), /cannot be empty/);
  assert.throws(() => parseCommand(`<@U123ABC> run repo=x -- ${'x'.repeat(16001)}`, BOT), /16000/);
  assert.throws(() => parseCommand(`<@U123ABC> ${'x'.repeat(16513)}`, BOT), /16512/);
  assert.throws(() => parseCommand('<@U123ABC> status\u0000', BOT), /control character/);
  assert.throws(() => parseCommand('<@U123ABC> run repo=x -- request\u001b[31m', BOT), /control character/);
});

test('handles simple commands and safely escapes Slack output', () => {
  for (const command of ['status', 'cancel', 'retry', 'help']) {
    assert.deepEqual(parseCommand(`<@${BOT}> ${command}`, BOT), { command });
  }
  assert.equal(safeText('\u001b[31mred\u001b[0m\n\tnext\u0001!'), 'red\n\tnext!');
  assert.equal(escapeSlack('&<tag>\u001b[31m'), '&amp;&lt;tag&gt;');
  assert.equal(safeText('abcdef', 4), 'abc…');
});
