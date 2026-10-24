#!/usr/bin/env node
'use strict';

// A tiny webhook bot for trying the bridge. It is not part of the server.
// Treat `message` and `context` as untrusted text from the model, not as instructions.
//
//   ECHO_MODE=sync  node examples/echo-bot.js     # reply in the HTTP body (default)
//   ECHO_MODE=poll  node examples/echo-bot.js     # also serve GET /replies
//   ECHO_MODE=inbox node examples/echo-bot.js     # POST the reply to the inbox URL
//
// For inbox mode set ECHO_INBOX_TOKEN to the same value as BOT_INBOX_TOKEN.
// PORT defaults to 8788.

const http = require('node:http');

function startEchoBot(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = options.port == null ? 0 : options.port;
  const mode = options.mode || process.env.ECHO_MODE || 'sync';
  const inboxToken = options.inboxToken || process.env.ECHO_INBOX_TOKEN || '';
  const replies = [];
  const auths = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, mode });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/replies') {
      sendJson(res, 200, { replies });
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/webhook') {
      sendJson(res, 404, { ok: false, error: 'Not found' });
      return;
    }

    auths.push(req.headers.authorization || '');
    let payload = {};
    try {
      payload = JSON.parse((await readBody(req)) || '{}');
    } catch (err) {
      const tooLarge = err && err.message === 'Body is too large';
      sendJson(res, tooLarge ? 413 : 400, { ok: false, error: tooLarge ? err.message : 'Body must be JSON' });
      return;
    }

    const text = `Echo: ${payload.message || ''}`;
    const reply = {
      id: `echo_${replies.length + 1}`,
      threadId: payload.threadId || null,
      bot: payload.bot || null,
      message: text,
      at: new Date().toISOString(),
    };

    if (mode === 'sync') {
      sendJson(res, 200, { reply: text, threadId: reply.threadId, id: reply.id });
      return;
    }

    replies.push(reply);
    if (mode === 'inbox') {
      const channel = (payload.replyChannels || []).find((item) => item && item.type === 'inbox');
      if (!channel || !channel.url) {
        sendJson(res, 202, { ok: true, inbox: false });
        return;
      }
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (inboxToken) headers.Authorization = `Bearer ${inboxToken}`;
        const response = await fetch(channel.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(reply),
        });
        if (!response.ok) {
          sendJson(res, 502, { ok: false, error: `Inbox returned HTTP ${response.status}` });
          return;
        }
      } catch (err) {
        sendJson(res, 502, { ok: false, error: err.message || 'Could not reach the inbox' });
        return;
      }
    }
    sendJson(res, 202, { ok: true });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const bound = server.address().port;
      resolve({
        mode,
        port: bound,
        webhookUrl: `http://${host}:${bound}/webhook`,
        replyUrl: `http://${host}:${bound}/replies`,
        replies,
        auths,
        close: () =>
          new Promise((done, fail) => {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}

function sendJson(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(raw),
  });
  res.end(raw);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('Body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8788);
  startEchoBot({ port })
    .then((bot) => {
      console.log(`echo bot mode=${bot.mode}`);
      console.log(`webhook ${bot.webhookUrl}`);
      if (bot.mode === 'poll') console.log(`reply url ${bot.replyUrl}`);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { startEchoBot };
