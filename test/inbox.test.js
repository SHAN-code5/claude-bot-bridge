'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ReplyStore } = require('../src/store');
const { startInbox, advertisedUrl, MAX_BODY } = require('../src/inbox');

async function boot(token) {
  const store = new ReplyStore({ secrets: token ? [token] : [] });
  const logs = [];
  const inbox = await startInbox({
    config: {
      inbox: { host: '127.0.0.1', port: 0, path: '/reply', token: token || null },
    },
    store,
    log: { info(message) { logs.push(message); }, error(message) { logs.push(message); } },
  });
  return { store, inbox, logs };
}

test('accepts authenticated replies, rejects bad tokens, and ignores duplicates', async () => {
  const { store, inbox, logs } = await boot('inbox-secret-value');
  try {
    const health = await fetch(`${inbox.localUrl.replace('/reply', '')}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const denied = await fetch(inbox.localUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token-value' },
      body: JSON.stringify({ message: 'nope', threadId: 'thr_1' }),
    });
    assert.equal(denied.status, 401);
    const deniedBody = await denied.text();
    assert.equal(deniedBody.includes('inbox-secret-value'), false);
    assert.equal(deniedBody.includes('wrong-token-value'), false);

    const either = await fetch(inbox.localUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-token-value',
        'X-Bridge-Token': 'inbox-secret-value',
      },
      body: JSON.stringify({ message: 'either header', threadId: 'thr_either' }),
    });
    assert.equal(either.status, 202);

    const headerToken = await fetch(inbox.localUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': 'inbox-secret-value' },
      body: JSON.stringify({ id: 'm1', message: 'from header', threadId: 'thr_1', bot: 'assistant' }),
    });
    assert.equal(headerToken.status, 202);
    const created = await headerToken.json();
    assert.equal(created.ok, true);

    const again = await fetch(inbox.localUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer inbox-secret-value' },
      body: JSON.stringify({ id: 'm1', message: 'from header', threadId: 'thr_1', bot: 'assistant' }),
    });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).duplicate, true);
    assert.equal(store.list().length, 2);
    assert.equal(store.list().some((reply) => reply.text === 'from header'), true);
    assert.equal(store.list().some((reply) => reply.text === 'either header'), true);
    assert.equal(logs.join('\n').includes('inbox-secret-value'), false);

    const bad = await fetch(inbox.localUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer inbox-secret-value' },
      body: '{"message"',
    });
    assert.equal(bad.status, 400);

    const empty = await fetch(inbox.localUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer inbox-secret-value' },
      body: JSON.stringify({ ok: true }),
    });
    assert.equal(empty.status, 400);

    const missing = await fetch(inbox.localUrl.replace('/reply', '/nope'), { method: 'POST' });
    assert.equal(missing.status, 404);
  } finally {
    await inbox.close();
  }
});

test('rejects oversized bodies and builds the public inbox URL', async () => {
  const { inbox } = await boot(null);
  try {
    const open = await fetch(inbox.localUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'open inbox' }),
    });
    assert.equal(open.status, 202);

    const huge = await fetch(inbox.localUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: `{"message":"${'x'.repeat(MAX_BODY)}"}`,
    });
    assert.equal(huge.status, 413);
  } finally {
    await inbox.close();
  }

  assert.equal(
    advertisedUrl('https://tunnel.example', '/reply', 'http://127.0.0.1:8787/reply'),
    'https://tunnel.example/reply'
  );
  assert.equal(
    advertisedUrl('https://tunnel.example/custom', '/reply', 'http://127.0.0.1:8787/reply'),
    'https://tunnel.example/custom'
  );
});
