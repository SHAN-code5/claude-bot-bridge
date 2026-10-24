'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLineReader } = require('../src/stdio');
const { listen, readBody, json, spawnBridge } = require('./helpers');

test('frames newline-delimited JSON across partial chunks', async () => {
  const lines = [];
  let finished = false;
  const reader = createLineReader(async (line) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    lines.push(line);
    finished = true;
  });
  const pending = reader.push('{"a":');
  reader.push('1}\n{"b":2}\r\n');
  assert.equal(finished, false);
  await pending;
  await reader.idle;
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test('the process speaks initialize, tools/list, and tools/call over stdio', async () => {
  const seen = [];
  const secret = 'super-secret-value';
  const webhook = await listen(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('standing reply');
      return;
    }
    const body = JSON.parse(await readBody(req));
    seen.push({ authorization: req.headers.authorization, body });
    json(res, 200, { reply: `pong:${body.message}`, threadId: body.threadId });
  });
  const child = spawnBridge({
    BOT_WEBHOOK_URL: `${webhook.url}/webhook`,
    BOT_WEBHOOK_KEY: secret,
    BOT_NAME: 'Helper',
    BOT_FROM: 'Claude Desktop',
    BOT_REPLY_URL: `${webhook.url}/file.txt`,
  });

  try {
    const init = await child.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'stdio-test', version: '0' },
      },
      1
    );
    assert.equal(init.result.protocolVersion, '2024-11-05');
    assert.equal(init.result.serverInfo.name, 'claude-bot-bridge');
    assert.match(init.result.instructions, /wait_for_reply/);

    child.notify('notifications/initialized');
    const listed = await child.request('tools/list', {}, 2);
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      ['list_bots', 'send_message', 'get_replies', 'wait_for_reply', 'broadcast_message', 'relay_conversation', 'stop_relay']
    );
    assert.deepEqual(listed.result.tools.find((tool) => tool.name === 'send_message').inputSchema.required, [
      'message',
    ]);

    child.stdin.write('this is not json\n');
    const sent = await child.request(
      'tools/call',
      { name: 'send_message', arguments: { message: 'hello', context: 'unit test' } },
      3
    );
    assert.equal(sent.result.isError, false);
    assert.match(sent.result.content[0].text, /pong:hello/);
    assert.match(sent.result.content[0].text, /threadId: thr_/);
    assert.equal(sent.result.content[0].text.includes(secret), false);

    assert.equal(seen.length, 1);
    assert.equal(seen[0].authorization, `Bearer ${secret}`);
    assert.equal(seen[0].body.from, 'Claude Desktop');
    assert.equal(seen[0].body.message, 'hello');
    assert.equal(seen[0].body.context, 'unit test');
    assert.equal(typeof seen[0].body.sentAt, 'string');
    assert.equal(seen[0].body.bot, 'default');
    assert.ok(Array.isArray(seen[0].body.replyChannels));

    const bots = await child.request('tools/call', { name: 'list_bots', arguments: {} }, 4);
    assert.equal(bots.result.isError, false);
    assert.equal(bots.result.content[0].text.includes(secret), false);
    assert.match(bots.result.content[0].text, /Helper/);

    const missing = await child.request('prompts/list', {}, 5);
    assert.equal(missing.error.code, -32601);

    const unknownTool = await child.request('tools/call', { name: 'nope', arguments: {} }, 6);
    assert.equal(unknownTool.result.isError, true);

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'wait_for_reply', arguments: { timeoutMs: 20000, pollIntervalMs: 1000 } },
      })}\n`
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    child.notify('notifications/cancelled', { requestId: 7 });
    const ping = await child.request('ping', {}, 8);
    assert.deepEqual(ping.result, {});
    assert.equal(child.unexpected.some((msg) => msg.id === 7), false);

    assert.equal(child.stderrText().includes(secret), false);
    assert.match(child.stderrText(), /stdio ready/);
    assert.ok(child.unexpected.some((msg) => msg.error && msg.error.code === -32700));
  } finally {
    const stopped = await child.stop();
    await webhook.close();
    assert.equal(stopped.code, 0);
  }
});

test('missing config, --help, and --version exit without waiting on stdin', async () => {
  const missing = spawnBridge({});
  const missingExit = await missing.stop();
  assert.equal(missingExit.code, 1);
  assert.match(missingExit.stderr, /BOT_WEBHOOK_URL/);
  assert.equal(missingExit.stderr.includes('super-secret-value'), false);

  const help = spawnBridge({}, ['--help']);
  let helpOut = '';
  help.stdout.on('data', (buf) => {
    helpOut += buf.toString('utf8');
  });
  const helpExit = await help.stop();
  assert.equal(helpExit.code, 0);
  assert.match(helpOut, /BOT_WEBHOOK_URL/);

  const version = spawnBridge({}, ['--version']);
  let versionOut = '';
  version.stdout.on('data', (buf) => {
    versionOut += buf.toString('utf8');
  });
  const versionExit = await version.stop();
  assert.equal(versionExit.code, 0);
  assert.equal(versionOut.trim(), '0.2.0');
});
