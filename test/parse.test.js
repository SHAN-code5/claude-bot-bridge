'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseReplyBody } = require('../src/parse');

test('parses the reply shapes bots actually send', () => {
  const single = parseReplyBody('{"reply":"hello","threadId":"thr_1","id":"m1"}', 'application/json', {
    source: 'sync',
    bot: 'assistant',
  });
  assert.equal(single.length, 1);
  assert.equal(single[0].text, 'hello');
  assert.equal(single[0].threadId, 'thr_1');
  assert.equal(single[0].bot, 'assistant');
  assert.equal(single[0].id, 'sync:assistant:m1');

  const list = parseReplyBody(
    JSON.stringify({
      replies: [
        { id: '1', message: 'one', threadId: 'thr_a', at: '2026-01-01T00:00:00.000Z' },
        { id: '2', text: 'two', thread: 'thr_b' },
      ],
    }),
    'application/json',
    { source: 'poll', bot: 'assistant' }
  );
  assert.deepEqual(
    list.map((reply) => reply.text),
    ['one', 'two']
  );
  assert.equal(list[1].threadId, 'thr_b');

  const plain = parseReplyBody('hello\nthere', 'text/plain', { source: 'poll', bot: 'assistant' });
  assert.equal(plain.length, 1);
  assert.equal(plain[0].text, 'hello\nthere');
  assert.equal(plain[0].threadId, null);

  const again = parseReplyBody('hello\nthere', 'text/plain', { source: 'poll', bot: 'assistant' });
  assert.equal(again[0].id, plain[0].id);
});

test('acks are not replies, but an explicit reply of ok is kept', () => {
  assert.deepEqual(parseReplyBody('ok', 'text/plain', { source: 'sync' }), []);
  assert.deepEqual(parseReplyBody('{"ok":true}', 'application/json', { source: 'sync' }), []);
  assert.deepEqual(parseReplyBody('Accepted', 'text/plain', { source: 'sync' }), []);
  const explicit = parseReplyBody('{"reply":"ok"}', 'application/json', { source: 'sync', bot: 'assistant' });
  assert.equal(explicit[0].text, 'ok');
});

test('invalid JSON advertised as JSON is ignored and a non-JSON object is plain text', () => {
  assert.deepEqual(parseReplyBody('{', 'application/json', { source: 'poll' }), []);
  const text = parseReplyBody('{not really', 'text/plain', { source: 'poll', bot: 'assistant' });
  assert.equal(text[0].text, '{not really');
});

test('the same sync text from two sends is stored separately', () => {
  const first = parseReplyBody('{"message":"done"}', 'application/json', {
    source: 'sync',
    bot: 'assistant',
    nonce: 'msg_1',
  });
  const second = parseReplyBody('{"message":"done"}', 'application/json', {
    source: 'sync',
    bot: 'assistant',
    nonce: 'msg_2',
  });
  assert.notEqual(first[0].id, second[0].id);
});

test('inbox replies without an id are unique', () => {
  const first = parseReplyBody('{"message":"same"}', 'application/json', { source: 'inbox' });
  const second = parseReplyBody('{"message":"same"}', 'application/json', { source: 'inbox' });
  assert.notEqual(first[0].id, second[0].id);
  assert.equal(first[0].text, 'same');
});
