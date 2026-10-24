'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startEchoBot } = require('../examples/echo-bot');
const { createService } = require('../src/tools');
const { ReplyStore } = require('../src/store');
const { startInbox } = require('../src/inbox');
const { load } = require('./helpers');

function serviceFor(config, store = new ReplyStore({ secrets: config.secrets })) {
  return createService({
    config,
    store,
    secrets: config.secrets,
    log: { info() {}, error() {} },
  });
}

test('the example bot can reply in the webhook body, a reply URL, or the inbox', async () => {
  const syncBot = await startEchoBot({ mode: 'sync' });
  try {
    const config = load({
      BOT_WEBHOOK_URL: syncBot.webhookUrl,
      BOT_WEBHOOK_KEY: 'super-secret-value',
      BOT_FROM: 'Claude Desktop',
    });
    const service = serviceFor(config);
    const sent = await service.call('send_message', { message: 'namaste', threadId: 'thr_echo' });
    assert.equal(sent.isError, false);
    assert.match(sent.content[0].text, /Echo: namaste/);
    assert.equal(syncBot.auths[0], 'Bearer super-secret-value');
  } finally {
    await syncBot.close();
  }

  const pollBot = await startEchoBot({ mode: 'poll' });
  try {
    const config = load({
      BOT_WEBHOOK_URL: pollBot.webhookUrl,
      BOT_WEBHOOK_KEY: 'super-secret-value',
      BOT_REPLY_URL: pollBot.replyUrl,
    });
    const service = serviceFor(config);
    const sent = await service.call('send_message', { message: 'poll me', threadId: 'thr_poll' });
    assert.match(sent.content[0].text, /No reply in the webhook response/);
    const replies = await service.call('get_replies', { threadId: 'thr_poll' });
    assert.match(replies.content[0].text, /Echo: poll me/);
  } finally {
    await pollBot.close();
  }

  const inboxBot = await startEchoBot({ mode: 'inbox', inboxToken: 'inbox-secret-value' });
  const config = load({
    BOT_WEBHOOK_URL: inboxBot.webhookUrl,
    BOT_WEBHOOK_KEY: 'super-secret-value',
    BOT_INBOX_TOKEN: 'inbox-secret-value',
  });
  config.inbox.enabled = true;
  config.inbox.port = 0;
  const store = new ReplyStore({ secrets: config.secrets });
  const inbox = await startInbox({ config, store, log: { info() {}, error() {} } });
  config.inbox.advertisedUrl = inbox.localUrl;
  config.inbox.localUrl = inbox.localUrl;
  try {
    const service = serviceFor(config, store);
    const sent = await service.call('send_message', { message: 'call me back', threadId: 'thr_in' });
    assert.match(sent.content[0].text, /No reply in the webhook response/);
    assert.equal(sent.content[0].text.includes('inbox-secret-value'), false);
    const replies = await service.call('get_replies', { threadId: 'thr_in' });
    assert.match(replies.content[0].text, /Echo: call me back/);
    assert.match(replies.content[0].text, /inbox/);
  } finally {
    await inbox.close();
    await inboxBot.close();
  }
});
