'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { loadConfig } = require('../src/config');
const { createService } = require('../src/tools');
const { ReplyStore } = require('../src/store');
const { createRuntime } = require('../src/runtime');
const { startSseClients } = require('../src/sse');
const { startDashboard } = require('../src/dashboard');
const { startHttpTransport } = require('../src/http-transport');
const { createApp } = require('../src/app');
const { signHeaders, verifySignature } = require('../src/signing');
const { initCommand, doctorCommand, packCommand, startTunnel, claudeConfigPath } = require('../src/commands');
const { startInbox } = require('../src/inbox');
const { listen, readBody, json, tempDir, load, spawnBridge } = require('./helpers');

function serviceFor(config, extras = {}) {
  const store = extras.store || new ReplyStore({ secrets: config.secrets });
  const runtime = extras.runtime || createRuntime();
  const service = createService({
    config,
    store,
    secrets: config.secrets,
    runtime,
    log: { info() {}, error() {} },
  });
  return { service, store, runtime };
}

test('init writes a Claude Desktop config without dropping other servers', () => {
  const home = tempDir();
  const target = claudeConfigPath('linux', home, {});
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ mcpServers: { other: { command: 'other' } } }));
  const result = initCommand({
    argv: ['--url', 'https://example.com/hook', '--key', 'super-secret-value', '--name', 'Helper'],
    platform: 'linux',
    homedir: home,
    env: {},
  });
  assert.equal(result.wrote, true);
  const saved = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(saved.mcpServers.other.command, 'other');
  assert.equal(saved.mcpServers['claude-bot-bridge'].env.BOT_WEBHOOK_URL, 'https://example.com/hook');
  assert.equal(saved.mcpServers['claude-bot-bridge'].env.BOT_NAME, 'Helper');
  assert.equal(claudeConfigPath('darwin', home, {}).includes('Library'), true);
  assert.equal(claudeConfigPath('win32', home, { APPDATA: path.join(home, 'AppData') }).includes('AppData'), true);
});

test('doctor reports a live webhook and a refused one', async () => {
  const bot = await listen(async (req, res) => {
    await readBody(req);
    json(res, 200, { reply: 'pong' });
  });
  try {
    const config = load({ BOT_WEBHOOK_URL: `${bot.url}/hook`, BOT_WEBHOOK_KEY: 'super-secret-value' });
    const report = await doctorCommand({ config, argv: [], env: {} });
    assert.equal(report.ok, true);
    assert.equal(report.checks.some((check) => check.name === 'webhook default' && check.ok), true);
  } finally {
    await bot.close();
  }
});

test('pack writes an mcpb zip that contains the manifest', () => {
  const out = path.join(tempDir(), 'claude-bot-bridge.mcpb');
  const result = packCommand({ out });
  const bytes = fs.readFileSync(out);
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  assert.equal(result.entries.includes('manifest.json'), true);
  assert.equal(result.entries.includes('bin/claude-bot-bridge.js'), true);
  const manifestStart = bytes.indexOf(Buffer.from('manifest_version'));
  assert.equal(manifestStart > 0, true);
});

test('tunnel parses a cloudflared URL', async () => {
  const tunnel = await startTunnel({
    port: 8787,
    timeoutMs: 1000,
    spawnImpl() {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setTimeout(() => child.stderr.emit('data', Buffer.from('your url is https://demo.trycloudflare.com\n')), 5);
      return child;
    },
  });
  assert.equal(tunnel.url, 'https://demo.trycloudflare.com');
  tunnel.close();
});

test('signs webhook bodies, retries 503, and enforces the rate limit', async () => {
  const secret = 'signing-secret-value';
  let hits = 0;
  let signature = '';
  const webhook = await listen(async (req, res) => {
    hits += 1;
    signature = req.headers['x-bridge-signature'] || '';
    const raw = await readBody(req);
    assert.equal(
      verifySignature(secret, raw, req.headers['x-bridge-timestamp'], signature),
      true
    );
    if (hits === 1) {
      json(res, 503, { error: 'busy' });
      return;
    }
    json(res, 200, { reply: 'after retry' });
  });
  try {
    const config = load({
      BOT_WEBHOOK_URL: webhook.url,
      BOT_WEBHOOK_KEY: 'super-secret-value',
      BOT_SIGNING_SECRET: secret,
      BOT_MAX_RETRIES: '2',
      BOT_RETRY_BASE_MS: '10',
      BOT_RATE_LIMIT_PER_MINUTE: '2',
    });
    const { service } = serviceFor(config);
    const sent = await service.call('send_message', { message: 'hello' });
    assert.equal(sent.isError, false);
    assert.match(sent.content[0].text, /after retry/);
    assert.equal(hits, 2);
    const second = await service.call('send_message', { message: 'again' });
    assert.equal(second.isError, false);
    const limited = await service.call('send_message', { message: 'too many' });
    assert.equal(limited.isError, true);
    assert.match(limited.content[0].text, /Rate limit/);
  } finally {
    await webhook.close();
  }
});

test('allowlist rejects a host that was not named', () => {
  assert.throws(
    () =>
      loadConfig({
        env: { BOT_WEBHOOK_URL: 'http://127.0.0.1:9/hook', BOT_ALLOWED_HOSTS: 'example.com' },
        cwd: tempDir(),
      }),
    /allowedHosts/
  );
});

test('inbox requires a valid HMAC when a signing secret is set', async () => {
  const store = new ReplyStore();
  const inbox = await startInbox({
    config: {
      inbox: { host: '127.0.0.1', port: 0, path: '/reply', token: null, signingSecret: 'inbox-signing-secret' },
    },
    store,
    log: { info() {}, error() {} },
  });
  try {
    const body = JSON.stringify({ message: 'signed', threadId: 'thr_sig' });
    const bad = await fetch(inbox.localUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(bad.status, 401);
    const headers = signHeaders('inbox-signing-secret', body);
    const good = await fetch(inbox.localUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    assert.equal(good.status, 202);
    assert.equal(store.list()[0].text, 'signed');
  } finally {
    await inbox.close();
  }
});

test('an SSE reply stream lands in the store', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('event: reply\ndata: {"message":"from sse","threadId":"thr_sse","id":"s1"}\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const store = new ReplyStore();
  const clients = startSseClients({
    config: {
      bots: {
        assistant: {
          id: 'assistant',
          sseUrl: `http://127.0.0.1:${port}/events`,
          key: '',
          keyHeader: 'Authorization',
          keyPrefix: '',
        },
      },
    },
    store,
    log: { info() {}, error() {} },
  });
  try {
    const started = Date.now();
    while (store.list().length === 0 && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(store.list()[0].text, 'from sse');
    assert.equal(store.list()[0].source, 'sse');
  } finally {
    await clients.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('broadcast and relay move messages between two bots until stopped', async () => {
  const control = { stop() {} };
  async function botServer() {
    return listen(async (req, res) => {
      const body = JSON.parse(await readBody(req));
      if (typeof body.context === 'string' && body.context.startsWith('relay')) control.stop();
      json(res, 200, { reply: `echo ${body.message}`, threadId: body.threadId, id: body.messageId });
    });
  }
  const left = await botServer();
  const right = await botServer();
  try {
    const config = load({
      CLAUDE_BOT_BRIDGE_BOTS: JSON.stringify({
        left: { name: 'Left', url: left.url },
        right: { name: 'Right', url: right.url },
      }),
      CLAUDE_BOT_BRIDGE_DEFAULT_BOT: 'left',
      BOT_RATE_LIMIT_PER_MINUTE: '30',
    });
    const runtime = createRuntime();
    const { service } = serviceFor(config, { runtime });
    const broadcast = await service.call('broadcast_message', { message: 'hi all', bots: ['left', 'right'] });
    assert.match(broadcast.content[0].text, /echo hi all/);
    assert.equal((broadcast.content[0].text.match(/echo hi all/g) || []).length, 2);

    const relayRuntime = createRuntime();
    control.stop = () => relayRuntime.requestStopRelay();
    const relayService = serviceFor(config, { runtime: relayRuntime }).service;
    const relay = await relayService.call('relay_conversation', {
      fromBot: 'left',
      toBot: 'right',
      message: 'start',
      maxTurns: 4,
      timeoutMs: 1000,
    });
    assert.match(relay.content[0].text, /Stopped by stop_relay/);
    assert.match(relay.content[0].text, /echo start/);
    assert.equal(relay.content[0].text.includes('Turn 2'), false);
  } finally {
    await left.close();
    await right.close();
  }
});

test('resources expose thread history and the http transport enforces origin and session', async () => {
  const config = load({ BOT_WEBHOOK_URL: 'https://example.com/hook', BOT_NAME: 'Helper' });
  const app = await createApp({ config, log: { info() {}, error() {} }, instructions: 'test' });
  app.store.add({ id: 'sent:1', text: 'hello', source: 'sent', bot: 'default', threadId: 'thr_hist', delivered: true });
  app.store.add({ id: 'sync:1', text: 'hi back', source: 'sync', bot: 'default', threadId: 'thr_hist', delivered: true });
  const listed = await app.handler({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
  assert.equal(listed.result.resources.some((item) => item.uri === 'bridge://threads'), true);
  const read = await app.handler({
    jsonrpc: '2.0',
    id: 2,
    method: 'resources/read',
    params: { uri: 'bridge://thread/thr_hist' },
  });
  assert.match(read.result.contents[0].text, /hello/);
  assert.match(read.result.contents[0].text, /hi back/);

  const httpServer = await startHttpTransport({
    handler: app.handler,
    runtime: app.runtime,
    host: '127.0.0.1',
    port: 0,
    token: 'http-token-value',
    allowedOrigins: [],
    log: { info() {}, error() {} },
  });
  try {
    const denied = await fetch(httpServer.url, {
      method: 'POST',
      headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }),
    });
    assert.equal(denied.status, 403);
    const unauth = await fetch(httpServer.url, {
      method: 'POST',
      headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }),
    });
    assert.equal(unauth.status, 401);
    const init = await fetch(httpServer.url, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        Authorization: 'Bearer http-token-value',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    });
    assert.equal(init.status, 200);
    const session = init.headers.get('mcp-session-id');
    assert.equal(typeof session, 'string');
    const tools = await fetch(httpServer.url, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        Authorization: 'Bearer http-token-value',
        'Mcp-Session-Id': session,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    const body = await tools.json();
    assert.equal(body.result.tools.some((tool) => tool.name === 'relay_conversation'), true);
  } finally {
    await httpServer.close();
    await app.close();
  }
});

test('the dashboard serves threads without secrets', async () => {
  const config = load({ BOT_WEBHOOK_URL: 'https://example.com/hook?key=super-secret-value', BOT_WEBHOOK_KEY: 'super-secret-value' });
  const store = new ReplyStore({ secrets: config.secrets });
  store.add({ id: '1', text: 'visible', source: 'sync', threadId: 'thr_ui', bot: 'default', delivered: true });
  const dashboard = await startDashboard({
    store,
    config,
    host: '127.0.0.1',
    port: 0,
    log: { info() {}, error() {} },
  });
  try {
    const page = await fetch(dashboard.url);
    assert.match(await page.text(), /claude-bot-bridge/);
    const state = await fetch(`${dashboard.url}api/state`).then((res) => res.json());
    assert.equal(state.threads[0].messages[0].text, 'visible');
    assert.equal(JSON.stringify(state).includes('super-secret-value'), false);
  } finally {
    await dashboard.close();
  }
});

test('http mode refuses a public bind without a token', async () => {
  const child = spawnBridge({ BOT_WEBHOOK_URL: 'https://example.com/hook' }, ['http', '--host', '0.0.0.0', '--port', '8099']);
  const result = await child.stop();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /localhost/);
});
