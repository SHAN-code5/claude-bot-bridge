'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { notificationFor } = require('./runtime');

function startHttpTransport({ handler, runtime, host, port, token, allowedOrigins, log }) {
  const sessions = new Map();
  const maxSessions = 100;
  runtime.subscribe((reply) => {
    const message = notificationFor(reply);
    for (const session of sessions.values()) session.send(message);
  });

  const server = http.createServer((req, res) => {
    handle(req, res, { handler, sessions, maxSessions, token, allowedOrigins, host, log }).catch((err) => {
      if (log) log.error(err.message || 'http transport failure');
      if (!res.headersSent) {
        const status = err && err.status === 413 ? 413 : 500;
        sendJson(res, status, { error: status === 413 ? 'Body is too large' : 'Internal error' });
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const bound = server.address().port;
      resolve({
        host,
        port: bound,
        url: `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${bound}/mcp`,
        close() {
          return new Promise((done, fail) => {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            server.close((err) => (err ? fail(err) : done()));
          });
        },
      });
    });
  });
}

async function handle(req, res, ctx) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname !== '/mcp') {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  if (!originAllowed(req.headers.origin, ctx.allowedOrigins)) {
    sendJson(res, 403, { error: 'Origin is not allowed' });
    return;
  }
  if (ctx.token && !bearerOk(req.headers.authorization || '', ctx.token)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  if (req.method === 'GET') return openStream(req, res, ctx);
  if (req.method === 'DELETE') return endSession(req, res, ctx);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, DELETE');
    sendJson(res, 405, { error: 'Use POST' });
    return;
  }

  const accept = req.headers.accept || '';
  if (!accept.includes('application/json') && !accept.includes('text/event-stream')) {
    sendJson(res, 400, { error: 'Accept must include application/json or text/event-stream' });
    return;
  }

  const raw = await readBody(req);
  let message;
  try {
    message = JSON.parse(raw || '');
  } catch {
    sendJson(res, 400, { error: 'Body must be JSON' });
    return;
  }
  if (Array.isArray(message)) {
    sendJson(res, 400, { error: 'Batch requests are not supported' });
    return;
  }

  const sessionHeader = req.headers['mcp-session-id'];
  const isInitialize = message && message.method === 'initialize';
  let session = sessionHeader ? ctx.sessions.get(sessionHeader) : null;
  if (sessionHeader && !session) {
    sendJson(res, 404, { error: 'Session not found' });
    return;
  }
  if (!isInitialize && !session) {
    sendJson(res, 400, { error: 'Mcp-Session-Id is required' });
    return;
  }
  if (isInitialize) session = createSession(ctx.sessions, ctx.maxSessions);

  const hasId = message.id !== undefined && message.id !== null;
  const isRequest = hasId && typeof message.method === 'string' && !message.method.startsWith('notifications/');
  if (!isRequest) {
    res.writeHead(202);
    res.end();
    return;
  }

  const response = await ctx.handler(message);
  if (isInitialize && session) res.setHeader('Mcp-Session-Id', session.id);
  sendJson(res, 200, response);
}

function openStream(req, res, ctx) {
  const session = ctx.sessions.get(req.headers['mcp-session-id'] || '');
  if (!session) {
    sendJson(res, 400, { error: 'Mcp-Session-Id is required' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': open\n\n');
  session.add(res);
  const beat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(beat);
    }
  }, 15000);
  if (typeof beat.unref === 'function') beat.unref();
  req.on('close', () => {
    clearInterval(beat);
    session.remove(res);
  });
}

function endSession(req, res, ctx) {
  const id = req.headers['mcp-session-id'];
  if (!id || !ctx.sessions.has(id)) {
    sendJson(res, 404, { error: 'Session not found' });
    return;
  }
  ctx.sessions.delete(id);
  res.writeHead(204);
  res.end();
}

function createSession(sessions, maxSessions) {
  while (sessions.size >= maxSessions) {
    const oldest = sessions.keys().next().value;
    sessions.delete(oldest);
  }
  const clients = new Set();
  const session = {
    id: crypto.randomBytes(16).toString('hex'),
    send(message) {
      const chunk = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
      for (const client of clients) {
        try {
          client.write(chunk);
        } catch {
          clients.delete(client);
        }
      }
    },
    add(client) {
      clients.add(client);
    },
    remove(client) {
      clients.delete(client);
    },
  };
  sessions.set(session.id, session);
  return session;
}

function originAllowed(origin, allowedOrigins) {
  if (!origin) return true;
  if (allowedOrigins && allowedOrigins.includes(origin)) return true;
  try {
    const url = new URL(origin);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1') return true;
  } catch {
    return false;
  }
  return false;
}

function bearerOk(authorization, token) {
  const presented = String(authorization || '').replace(/^Bearer\s+/i, '').trim();
  const left = Buffer.from(presented);
  const right = Buffer.from(token);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(raw),
    'Cache-Control': 'no-store',
  });
  res.end(raw);
}

module.exports = { startHttpTransport, originAllowed };
