'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ReplyStore } = require('../src/store');
const { tempDir } = require('./helpers');

test('dedupes, filters, marks delivered, and redacts secrets in the state file', () => {
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  const secrets = ['super-secret-value'];
  const store = new ReplyStore({ file, secrets });
  const first = store.add({
    id: 'r1',
    text: 'hello super-secret-value',
    source: 'inbox',
    bot: 'assistant',
    threadId: 'thr_a',
    at: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(first.text, 'hello [REDACTED]');
  assert.equal(store.add({ id: 'r1', text: 'hello again', source: 'inbox' }), null);
  store.add({
    id: 'r2',
    text: 'other thread',
    source: 'poll',
    bot: 'writer',
    threadId: 'thr_b',
    at: '2026-02-01T00:00:00.000Z',
  });
  store.add({
    id: 'r3',
    text: 'unscoped',
    source: 'poll',
    bot: null,
    threadId: null,
    at: '2020-01-01T00:00:00.000Z',
  });

  assert.equal(store.list({ threadId: 'thr_a' }).length, 2);
  assert.equal(store.list({ bot: 'writer' }).map((reply) => reply.id).join(), 'r2,r3');
  assert.deepEqual(
    store.list({ sinceMs: Date.parse('2026-01-15T00:00:00.000Z'), threadId: 'thr_b' }).map((reply) => reply.id),
    ['r2']
  );

  assert.equal(store.nextUndelivered({ threadId: 'thr_a' }).id, 'r1');
  store.markDelivered('r1');
  assert.equal(store.nextUndelivered({ threadId: 'thr_a' }).id, 'r3');

  // Writes are coalesced; flush() is what close() calls.
  assert.equal(fs.existsSync(file), false);
  store.flush();
  const restored = new ReplyStore({ file, secrets });
  if (process.platform !== 'win32') {
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600);
  }
  assert.equal(restored.list().length, 3);
  assert.equal(restored.list()[0].text.includes('super-secret-value'), false);
  assert.equal(restored.list()[0].delivered, true);
});

test('drops the oldest reply past the cap so memory stays bounded', () => {
  const store = new ReplyStore({ max: 2 });
  store.add({ id: 'a', text: 'one', source: 'inbox' });
  store.add({ id: 'b', text: 'two', source: 'inbox' });
  store.add({ id: 'c', text: 'three', source: 'inbox' });
  assert.deepEqual(store.ids(), ['b', 'c']);
  assert.ok(store.add({ id: 'a', text: 'one again', source: 'inbox' }));
});

test('a corrupt state file fails with a clear message', () => {
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{');
  assert.throws(() => new ReplyStore({ file }), /not valid JSON/);
});
