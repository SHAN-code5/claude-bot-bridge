'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { parseReplyBody } = require('./parse');

const MAX_BODY = 256 * 1024;

function startInbox({ config, store, log }) {
  const inbox = config.inbox;
  const server = http.createServer((req, res) => {
    handle(req, res, {
      replyPath: inbox.path,
      token: inbox.token,
      store,
      log: log || { info() {}, error() {} },
    }).catch((err) => {
      if (err && err.status === 413) return;
      if (log) log.error(err.message || 'inbox failure');
      if (!res.headersSent && !res.writableEnded) {
        sendJson(res, 500, { ok: false, error: 'Internal error' });
      }
    });
  });
  server.requestTimeout = 20_000;

  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(inbox.port, inbox.host, () => {
      server.removeListener('error', onError);
      server.on('error', (err) => {
        const reason = err && (err.code || err.message) ? err.code || err.message : 'socket error';
        if (log) log.error(`inbox error: ${reason}`);
      });
      const address = server.address();
      const boundPort = address && typeof address === 'object' ? address.port : inbox.port;
      const localHost = inbox.host === '0.0.0.0' || inbox.host === '::' ? '127.0.0.1' : inbox.host;
      const localUrl = `http://${formatHost(localHost)}:${boundPort}${inbox.path}`;
      resolve({
        server,
        host: inbox.host,
        port: boundPort,
        path: inbox.path,
        localUrl,
        tokenRequired: Boolean(inbox.token),
        close() {
          return new Promise((resolve, reject) => {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            server.close((err) => (err ? reject(err) : resolve()));
          });
        },
      });
    });
  });
}

function advertisedUrl(publicUrl, replyPath, localUrl) {
  if (!publicUrl) return localUrl;
  const url = new URL(publicUrl);
  if (url.pathname === '/' || url.pathname === '') url.pathname = replyPath;
  return url.toString();
}

async function handle(req, res, ctx) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/health') {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end();
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }
  if (url.pathname !== ctx.replyPath) {
    sendJson(res, 404, { ok: false, error: 'Not found' });
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { ok: false, error: 'Use POST' });
    return;
  }
  if (ctx.token && !tokenOk(req, ctx.token)) {
    ctx.log.info('inbox rejected a request');
    sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    return;
  }

  const raw = await readBody(req, res);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { ok: false, error: 'Body must be JSON' });
    return;
  }
  const replies = parseReplyBody(JSON.stringify(parsed), 'application/json', { source: 'inbox' });
  if (replies.length === 0) {
    sendJson(res, 400, {
      ok: false,
      error: 'JSON needs a message, reply, or text field',
    });
    return;
  }
  const stored = [];
  for (const reply of replies) {
    const saved = ctx.store.add(reply);
    if (saved) stored.push(saved);
  }
  if (stored.length === 0) {
    sendJson(res, 200, { ok: true, duplicate: true });
    return;
  }
  ctx.log.info(
    `inbox accepted id=${oneLine(stored[0].id)} thread=${oneLine(stored[0].threadId)} bot=${oneLine(stored[0].bot)}`
  );
  sendJson(res, 202, { ok: true, id: stored[0].id, count: stored.length });
}

function tokenOk(req, token) {
  const candidates = [];
  const authorization = req.headers.authorization || '';
  if (/^bearer\s+/i.test(authorization)) candidates.push(authorization.replace(/^bearer\s+/i, '').trim());
  else if (authorization.trim()) candidates.push(authorization.trim());
  const header = req.headers['x-bridge-token'];
  if (typeof header === 'string' && header.trim()) candidates.push(header.trim());
  return candidates.some((value) => safeEqual(value, token));
}

function oneLine(value) {
  const text = value == null || value === '' ? '-' : String(value);
  return text.replace(/[\r\n]/g, ' ').slice(0, 120);
}

function safeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue));
  const right = Buffer.from(String(rightValue));
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function readBody(req, res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        sendJson(res, 413, { ok: false, error: 'Body is too large' });
        const error = new Error('payload too large');
        error.status = 413;
        finish(() => reject(error));
        res.on('finish', () => req.destroy());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      finish(() => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', (err) => {
      finish(() => reject(err));
    });
  });
}

function sendJson(res, status, body) {
  if (!res || res.writableEnded || res.headersSent) return;
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(raw),
    'Cache-Control': 'no-store',
  });
  res.end(raw);
}

function formatHost(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

module.exports = { startInbox, advertisedUrl, MAX_BODY };
