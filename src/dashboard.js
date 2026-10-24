'use strict';

const http = require('node:http');
const { loopbackHostHeader } = require('./policy');

function startDashboard({ store, config, host, port, log }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (!loopbackHostHeader(req.headers.host)) {
      send(res, 403, 'text/plain', 'Host is not allowed');
      return;
    }
    if (req.method !== 'GET') {
      send(res, 405, 'text/plain', 'Use GET');
      return;
    }
    if (url.pathname === '/api/state') {
      send(res, 200, 'application/json', JSON.stringify(snapshot(store, config)));
      return;
    }
    if (url.pathname === '/') {
      send(res, 200, 'text/html; charset=utf-8', page());
      return;
    }
    send(res, 404, 'text/plain', 'Not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const bound = server.address().port;
      const shownHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
      if (log) log.info(`dashboard http://${shownHost}:${bound}/`);
      resolve({
        host,
        port: bound,
        url: `http://${shownHost}:${bound}/`,
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

function snapshot(store, config) {
  return {
    defaultBot: config.defaultBot,
    bots: Object.values(config.bots).map((bot) => ({
      id: bot.id,
      name: bot.name,
      host: hostOf(bot.url),
      auth: Boolean(bot.key),
      signing: Boolean(bot.signingSecret),
      poll: Boolean(bot.replyUrl),
      sse: Boolean(bot.sseUrl),
    })),
    threads: store.threads().map((thread) => ({
      ...thread,
      messages: store
        .list()
        .filter((item) => (item.threadId || 'unscoped') === thread.threadId)
        .map((item) => ({
          id: item.id,
          source: item.source,
          bot: item.bot,
          at: item.at || item.receivedAt,
          text: item.text,
        })),
    })),
  };
}

function hostOf(value) {
  try {
    return new URL(value).host;
  } catch {
    return '';
  }
}

function page() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>claude-bot-bridge</title>
  <style>
    :root { color-scheme: light dark; }
    body { font: 15px/1.45 system-ui, sans-serif; margin: 0; }
    header, main { padding: 16px 20px; }
    header { border-bottom: 1px solid #8884; }
    h1 { font-size: 1.15rem; margin: 0 0 4px; }
    .muted { opacity: 0.75; }
    .grid { display: grid; grid-template-columns: 220px 1fr; gap: 16px; }
    button { font: inherit; text-align: left; width: 100%; margin: 0 0 6px; padding: 8px; }
    article { white-space: pre-wrap; border-top: 1px solid #8884; padding: 10px 0; }
    .tag { font-size: 12px; opacity: 0.7; }
    @media (max-width: 700px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>claude-bot-bridge</h1>
    <p class="muted" id="summary">Loading…</p>
  </header>
  <main class="grid">
    <nav id="threads"></nav>
    <section id="messages"></section>
  </main>
  <script>
    let selected = null;
    async function refresh() {
      const state = await fetch('/api/state').then((res) => res.json());
      document.getElementById('summary').textContent =
        'Default bot: ' + state.defaultBot + ' · ' + state.bots.map((bot) => bot.id).join(', ');
      const nav = document.getElementById('threads');
      nav.replaceChildren();
      if (state.threads.length === 0) nav.textContent = 'No threads yet.';
      for (const thread of state.threads) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = thread.threadId + ' (' + thread.count + ')';
        button.addEventListener('click', () => { selected = thread.threadId; draw(state); });
        nav.appendChild(button);
      }
      if (!selected && state.threads[0]) selected = state.threads[0].threadId;
      draw(state);
    }
    function draw(state) {
      const box = document.getElementById('messages');
      const thread = state.threads.find((item) => item.threadId === selected);
      box.replaceChildren();
      if (!thread) { box.textContent = 'Pick a thread.'; return; }
      for (const message of thread.messages) {
        const article = document.createElement('article');
        const tag = document.createElement('div');
        tag.className = 'tag';
        tag.textContent = message.source + ' · ' + (message.bot || '-') + ' · ' + message.at;
        article.appendChild(tag);
        article.appendChild(document.createTextNode(message.text));
        box.appendChild(article);
      }
    }
    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>`;
}

function send(res, status, type, body) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

module.exports = { startDashboard, snapshot };
