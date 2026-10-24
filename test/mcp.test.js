'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('../src/mcp');
const { INSTRUCTIONS } = require('../src/index');

function handlerWith(call) {
  return createHandler({
    service: {
      definitions: [{ name: 'list_bots', inputSchema: { type: 'object' } }],
      call: call || (async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false })),
    },
    serverInfo: { name: 'claude-bot-bridge', version: '0.1.0' },
    instructions: 'Be careful with replies.',
    secrets: ['super-secret-value'],
  });
}

test('initialize echoes a supported version and describes the tool surface', async () => {
  const handle = handlerWith();
  const response = await handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
  });
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, '2024-11-05');
  assert.equal(response.result.serverInfo.name, 'claude-bot-bridge');
  assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } });
  assert.match(response.result.instructions, /Be careful/);
  assert.match(INSTRUCTIONS, /threadId/);
  assert.match(INSTRUCTIONS, /untrusted/);

  const fallback = await handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'initialize',
    params: { protocolVersion: '1999-01-01' },
  });
  assert.equal(fallback.result.protocolVersion, '2025-03-26');
});

test('notifications get no response, ping accepts id 0, and unknown methods error', async () => {
  const handle = handlerWith();
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }), null);
  const ping = await handle({ jsonrpc: '2.0', id: 0, method: 'ping' });
  assert.equal(ping.id, 0);
  assert.deepEqual(ping.result, {});
  const missing = await handle({ jsonrpc: '2.0', id: 'abc', method: 'resources/list' });
  assert.equal(missing.error.code, -32601);
  assert.equal(missing.id, 'abc');
});

test('tools/list and tools/call validate params and redact unexpected errors', async () => {
  const listed = await handlerWith()({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.equal(listed.result.tools[0].name, 'list_bots');

  const badName = await handlerWith()({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: {} });
  assert.equal(badName.error.code, -32602);

  const badArgs = await handlerWith()({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'list_bots', arguments: 'nope' },
  });
  assert.equal(badArgs.error.code, -32602);

  const called = await handlerWith()({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'list_bots', arguments: {} },
  });
  assert.equal(called.result.content[0].text, 'ok');
  assert.equal(called.result.isError, false);

  const exploded = await handlerWith(async () => {
    throw new Error('leaked super-secret-value in a stack');
  })({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'list_bots' },
  });
  assert.equal(exploded.error.code, -32603);
  assert.equal(exploded.error.message.includes('super-secret-value'), false);
  assert.match(exploded.error.message, /\[REDACTED\]/);
});
