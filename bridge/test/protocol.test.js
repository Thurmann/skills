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

test('rejects missing, empty, and oversized requests', () => {
  assert.throws(() => parseCommand('<@U123ABC> run repo=x', BOT), /requires --/);
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
