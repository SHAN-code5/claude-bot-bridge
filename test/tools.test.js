'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ReplyStore } = require('../src/store');
const { createService } = require('../src/tools');
const { startInbox } = require('../src/inbox');
const { load, listen, readBody, json } = require('./helpers');

function use(config, store = new ReplyStore({ secrets: config.secrets })) {
  return {
    store,
    service: createService({
      config,
      store,
      secrets: config.secrets,
      log: { info() {}, error() {} },
    }),
  };
}

test('send_message returns a synchronous reply and does not repeat it', async () => {
  const secret = 'super-secret-value';
  let seen;
  const webhook = await listen(async (req, res) => {
    seen = { authorization: req.headers.authorization, body: JSON.parse(await readBody(req)) };
    json(res, 200, { reply: 'pong', threadId: JSON.parse(JSON.stringify(seen.body)).threadId });
  });
  try {
    const config = load({
      BOT_WEBHOOK_URL: `${webhook.url}/hook`,
      BOT_WEBHOOK_KEY: secret,
      BOT_NAME: 'Helper',
    });
    const { service } = use(config);
    const sent = await service.call('send_message', { message: 'hello', threadId: 'thr_demo' });
    assert.equal(sent.isError, false);
    assert.match(sent.content[0].text, /Reply \(sync\):\npong/);
    assert.match(sent.content[0].text, /threadId: thr_demo/);
    assert.equal(seen.authorization, `Bearer ${secret}`);
    assert.equal(seen.body.context, '');
    assert.equal(seen.body.threadId, 'thr_demo');
    assert.equal(JSON.stringify(seen.body).includes(secret), false);

    const waited = await service.call('wait_for_reply', { threadId: 'thr_demo', timeoutMs: 0 });
    assert.equal(waited.isError, false);
    assert.match(waited.content[0].text, /no reply URL or inbox/i);
    assert.equal(waited.content[0].text.includes('pong'), false);
  } finally {
    await webhook.close();
  }
});

test('webhook failures redact secrets and redirects are not followed', async () => {
  const secret = 'super-secret-value';
  const failing = await listen(async (req, res) => {
    await readBody(req);
    json(res, 500, { error: `leaked ${secret}` });
  });
  try {
    const config = load({ BOT_WEBHOOK_URL: `${failing.url}/hook`, BOT_WEBHOOK_KEY: secret });
    const { service } = use(config);
    const result = await service.call('send_message', { message: 'hello' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /HTTP 500/);
    assert.match(result.content[0].text, /\[REDACTED\]/);
    assert.equal(result.content[0].text.includes(secret), false);
  } finally {
    await failing.close();
  }

  let hits = 0;
  const redirecting = await listen((req, res) => {
    hits += 1;
    res.writeHead(302, { Location: `${redirecting.url}/elsewhere` });
    res.end('go away');
  });
  try {
    const config = load({ BOT_WEBHOOK_URL: `${redirecting.url}/hook`, BOT_WEBHOOK_KEY: secret });
    const { service } = use(config);
    const result = await service.call('send_message', { message: 'hello' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /redirect/i);
    assert.equal(hits, 1);
    assert.equal(result.content[0].text.includes(secret), false);
  } finally {
    await redirecting.close();
  }
});

test('a custom header can send the key with an empty prefix', async () => {
  let header;
  const webhook = await listen(async (req, res) => {
    header = req.headers['x-api-key'];
    await readBody(req);
    res.writeHead(204);
    res.end();
  });
  try {
    const config = load({
      BOT_WEBHOOK_URL: webhook.url,
      BOT_WEBHOOK_KEY: 'raw-key-value',
      BOT_KEY_HEADER: 'X-Api-Key',
      BOT_KEY_PREFIX: '',
    });
    const { service } = use(config);
    const result = await service.call('send_message', { message: 'hello' });
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /status: 204/);
    assert.match(result.content[0].text, /No reply in the webhook response/);
    assert.equal(header, 'raw-key-value');
  } finally {
    await webhook.close();
  }
});

test('polls a reply URL, keeps thread ids apart, and does not treat a stale file as a new wait result', async () => {
  let text = 'old reply';
  let cacheHeader;
  const server = await listen((req, res) => {
    cacheHeader = req.headers['cache-control'];
    if (req.url === '/replies.json') {
      json(res, 200, {
        replies: [
          { id: '1', threadId: 'thr_a', message: 'for a', at: '2026-01-01T00:00:00.000Z' },
          { id: '2', threadId: 'thr_b', message: 'for b', at: '2026-02-01T00:00:00.000Z' },
        ],
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(text);
  });
  try {
    const config = load({
      BOT_ID: 'assistant',
      BOT_NAME: 'Assistant',
      BOT_WEBHOOK_URL: 'https://example.com/unused',
      BOT_REPLY_URL: `${server.url}/file.txt`,
      CLAUDE_BOT_BRIDGE_BOTS: JSON.stringify({
        notes: { name: 'Notes', url: 'https://example.com/notes', replyUrl: `${server.url}/replies.json` },
      }),
      CLAUDE_BOT_BRIDGE_DEFAULT_BOT: 'assistant',
    });
    const { service } = use(config);

    const allNotes = await service.call('get_replies', { bot: 'notes' });
    assert.match(allNotes.content[0].text, /for a/);
    assert.match(allNotes.content[0].text, /for b/);
    const onlyA = await service.call('get_replies', { bot: 'notes', threadId: 'thr_a' });
    assert.match(onlyA.content[0].text, /for a/);
    assert.equal(onlyA.content[0].text.includes('for b'), false);
    const latest = await service.call('get_replies', { bot: 'notes', limit: 1 });
    assert.match(latest.content[0].text, /showing latest 1/);
    assert.match(latest.content[0].text, /for b/);
    assert.equal(latest.content[0].text.includes('for a'), false);
    assert.equal(cacheHeader, 'no-cache');

    const stale = await service.call('wait_for_reply', {
      bot: 'assistant',
      threadId: 'thr_live',
      timeoutMs: 400,
      pollIntervalMs: 200,
    });
    assert.equal(stale.isError, false);
    assert.match(stale.content[0].text, /No new reply arrived/);
    assert.equal(stale.content[0].text.includes('old reply'), false);

    const existing = await service.call('wait_for_reply', {
      bot: 'assistant',
      includeExisting: true,
      timeoutMs: 1000,
      pollIntervalMs: 200,
    });
    assert.match(existing.content[0].text, /old reply/);
  } finally {
    await server.close();
  }

  let polls = 0;
  const changing = await listen((req, res) => {
    polls += 1;
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    // First poll is the wait snapshot. The next poll is the new reply.
    res.end(polls === 1 ? 'old reply' : 'fresh reply');
  });
  try {
    const config = load({
      BOT_WEBHOOK_URL: 'https://example.com/unused',
      BOT_REPLY_URL: `${changing.url}/file.txt`,
    });
    const { service } = use(config);
    const waited = await service.call('wait_for_reply', {
      threadId: 'thr_live',
      timeoutMs: 2000,
      pollIntervalMs: 200,
    });
    assert.equal(waited.isError, false);
    assert.match(waited.content[0].text, /fresh reply/);
    assert.equal(waited.content[0].text.includes('old reply'), false);
  } finally {
    await changing.close();
  }
});

test('wait_for_reply returns an inbox post and ignores it when asked', async () => {
  let postedPayload;
  const webhook = await listen(async (req, res) => {
    postedPayload = JSON.parse(await readBody(req));
    json(res, 202, { ok: true });
  });
  const config = load({
    BOT_WEBHOOK_URL: `${webhook.url}/hook`,
    BOT_WEBHOOK_KEY: 'super-secret-value',
    BOT_INBOX_TOKEN: 'inbox-secret-value',
  });
  config.inbox.enabled = true;
  config.inbox.port = 0;
  const store = new ReplyStore({ secrets: config.secrets });
  const inbox = await startInbox({ config, store, log: { info() {}, error() {} } });
  config.inbox.localUrl = inbox.localUrl;
  config.inbox.advertisedUrl = inbox.localUrl;
  const { service } = use(config, store);

  try {
    const sent = await service.call('send_message', { message: 'ping', threadId: 'thr_box' });
    assert.match(sent.content[0].text, /No reply in the webhook response/);
    assert.equal(JSON.stringify(postedPayload).includes('inbox-secret-value'), false);
    assert.equal(postedPayload.replyChannels.some((channel) => channel.type === 'inbox' && channel.url === inbox.localUrl), true);

    const waiting = service.call('wait_for_reply', {
      threadId: 'thr_box',
      timeoutMs: 2000,
      pollIntervalMs: 200,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const posted = await fetch(inbox.localUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer inbox-secret-value',
      },
      body: JSON.stringify({ message: 'arrived', threadId: 'thr_box', bot: 'default' }),
    });
    assert.equal(posted.status, 202);
    const result = await waiting;
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /arrived/);
    assert.match(result.content[0].text, /via inbox/);

    await fetch(inbox.localUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': 'inbox-secret-value' },
      body: JSON.stringify({ message: 'earlier', threadId: 'thr_box', bot: 'default' }),
    });
    const ignored = await service.call('wait_for_reply', {
      threadId: 'thr_box',
      ignoreExisting: true,
      timeoutMs: 400,
      pollIntervalMs: 200,
    });
    assert.match(ignored.content[0].text, /No new reply arrived/);
    assert.equal(ignored.content[0].text.includes('earlier'), false);

    const read = await service.call('get_replies', { threadId: 'thr_box' });
    assert.match(read.content[0].text, /arrived/);
    assert.match(read.content[0].text, /earlier/);
  } finally {
    await inbox.close();
    await webhook.close();
  }
});

test('rejects bad tool arguments and unknown bots', async () => {
  const config = load({
    CLAUDE_BOT_BRIDGE_BOTS: JSON.stringify({
      writer: { name: 'Writer', url: 'https://example.com/writer' },
      coder: { name: 'Coder', url: 'https://example.com/coder' },
    }),
    CLAUDE_BOT_BRIDGE_DEFAULT_BOT: 'writer',
  });
  const { service } = use(config);
  const missing = await service.call('send_message', {});
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /message is required/);

  const badThread = await service.call('send_message', { message: 'hi', threadId: 'has spaces' });
  assert.equal(badThread.isError, true);

  const unknown = await service.call('send_message', { message: 'hi', bot: 'nope' });
  assert.match(unknown.content[0].text, /Unknown bot "nope"/);
  assert.match(unknown.content[0].text, /writer/);

  const both = await service.call('wait_for_reply', { includeExisting: true, ignoreExisting: true, timeoutMs: 0 });
  assert.match(both.content[0].text, /only one of includeExisting or ignoreExisting/);

  const listed = await service.call('list_bots', {});
  assert.match(listed.content[0].text, /Default bot: writer/);
  assert.equal(listed.content[0].text.includes('https://example.com/coder'), true);
});

test('a reply URL error is reported without hiding replies already stored', async () => {
  const config = load({
    BOT_WEBHOOK_URL: 'https://example.com/hook',
    BOT_REPLY_URL: 'http://127.0.0.1:9/replies.json',
    BOT_TIMEOUT_MS: '1000',
  });
  const store = new ReplyStore({ secrets: config.secrets });
  store.add({ id: 'kept', text: 'already here', source: 'inbox', bot: 'default', threadId: 'thr_1' });
  const { service } = use(config, store);
  const result = await service.call('get_replies', { threadId: 'thr_1' });
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /already here/);
  assert.match(result.content[0].text, /Poll error:/);
});
