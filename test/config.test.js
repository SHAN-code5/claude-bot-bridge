'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, ConfigError } = require('../src/config');
const { tempDir, root } = require('./helpers');

function writeJson(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

test('env vars alone configure one bot and never require a file', () => {
  const config = loadConfig({
    env: {
      BOT_WEBHOOK_URL: 'https://example.com/hook',
      BOT_WEBHOOK_KEY: 'super-secret-value',
      BOT_NAME: 'Helper',
      BOT_FROM: 'Claude Desktop',
      BOT_REPLY_URL: 'https://example.com/replies.json',
    },
    cwd: tempDir(),
  });
  assert.equal(config.defaultBot, 'default');
  assert.equal(config.bots.default.url, 'https://example.com/hook');
  assert.equal(config.bots.default.key, 'super-secret-value');
  assert.equal(config.bots.default.keyHeader, 'Authorization');
  assert.equal(config.bots.default.keyPrefix, 'Bearer ');
  assert.equal(config.bots.default.name, 'Helper');
  assert.equal(config.bots.default.replyUrl, 'https://example.com/replies.json');
  assert.equal(config.from, 'Claude Desktop');
  assert.equal(Object.keys(config).includes('secrets'), false);
  assert.ok(config.secrets.includes('super-secret-value'));
});

test('empty key prefix is preserved and a non-Authorization header gets no default prefix', () => {
  const config = loadConfig({
    env: {
      BOT_WEBHOOK_URL: 'https://example.com/hook',
      BOT_WEBHOOK_KEY: 'abc12345',
      BOT_KEY_HEADER: 'X-Api-Key',
      BOT_KEY_PREFIX: '',
    },
    cwd: tempDir(),
  });
  assert.equal(config.bots.default.keyHeader, 'X-Api-Key');
  assert.equal(config.bots.default.keyPrefix, '');
});

test('shorthand config file matches the original prototype shape', () => {
  const dir = tempDir();
  writeJson(dir, 'config.json', {
    url: 'https://bots.example/hook',
    key: 'prototype-secret',
    keyHeader: 'Authorization',
    keyPrefix: 'Bearer ',
    name: 'Grok',
    replyUrl: 'https://bots.example/reply.txt',
  });
  const config = loadConfig({ argv: ['--config', 'config.json'], env: {}, cwd: dir });
  assert.equal(config.bots.default.name, 'Grok');
  assert.equal(config.bots.default.url, 'https://bots.example/hook');
  assert.equal(config.bots.default.keyPrefix, 'Bearer ');
  assert.equal(config.bots.default.replyUrl, 'https://bots.example/reply.txt');
});

test('env overrides the default bot from a file and can add inbox settings', () => {
  const dir = tempDir();
  writeJson(dir, 'claude-bot-bridge.config.json', {
    defaultBot: 'assistant',
    bots: {
      assistant: {
        name: 'Assistant',
        url: 'https://example.com/old',
        key: 'file-secret-value',
      },
    },
  });
  const config = loadConfig({
    env: {
      BOT_WEBHOOK_URL: 'https://example.com/new',
      BOT_INBOX_PORT: '0',
      BOT_INBOX_TOKEN: 'inbox-secret-value',
    },
    cwd: dir,
  });
  assert.equal(config.bots.assistant.url, 'https://example.com/new');
  assert.equal(config.bots.assistant.key, 'file-secret-value');
  assert.equal(config.inbox.enabled, true);
  assert.equal(config.inbox.port, 0);
  assert.equal(config.inbox.token, 'inbox-secret-value');
});

test('whole-string placeholders are optional and mixed placeholders must be set', () => {
  const dir = tempDir();
  const file = writeJson(dir, 'bridge.json', {
    bots: {
      assistant: {
        url: '${BOT_WEBHOOK_URL}',
        key: '${BOT_WEBHOOK_KEY}',
        replyUrl: '${BOT_REPLY_URL}',
      },
    },
  });
  const config = loadConfig({
    configPath: file,
    env: { BOT_WEBHOOK_URL: 'https://example.com/hook', BOT_WEBHOOK_KEY: 'super-secret-value' },
    cwd: dir,
  });
  assert.equal(config.bots.assistant.url, 'https://example.com/hook');
  assert.equal(config.bots.assistant.key, 'super-secret-value');
  assert.equal(config.bots.assistant.replyUrl, undefined);

  assert.throws(
    () =>
      loadConfig({
        configPath: writeJson(dir, 'mixed.json', {
          bots: { assistant: { url: 'https://example.com/${BOT_PATH}' } },
        }),
        env: {},
        cwd: dir,
      }),
    (err) => err instanceof ConfigError && /BOT_PATH/.test(err.message)
  );
});

test('the shipped example config loads when the webhook env vars are set', () => {
  const config = loadConfig({
    argv: ['--config', path.join(root, 'examples', 'config.example.json')],
    env: {
      BOT_WEBHOOK_URL: 'https://example.com/hook',
      BOT_WEBHOOK_KEY: 'super-secret-value',
    },
    cwd: tempDir(),
  });
  assert.equal(config.defaultBot, 'assistant');
  assert.equal(config.bots.assistant.name, 'Assistant');
  assert.equal(config.bots.assistant.url, 'https://example.com/hook');
  assert.equal(config.bots.assistant.key, 'super-secret-value');
  assert.equal(config.inbox.enabled, false);
});

test('validation errors are specific and do not echo secrets', () => {
  const cwd = tempDir();
  assert.throws(
    () => loadConfig({ env: {}, cwd }),
    (err) => err instanceof ConfigError && /BOT_WEBHOOK_URL/.test(err.message)
  );

  assert.throws(
    () =>
      loadConfig({
        env: { BOT_WEBHOOK_URL: 'super-secret-value', BOT_WEBHOOK_KEY: 'super-secret-value' },
        cwd,
      }),
    (err) => {
      assert.equal(err.message.includes('super-secret-value'), false);
      assert.match(err.message, /not a valid URL/);
      assert.match(err.message, /\[REDACTED\]/);
      return true;
    }
  );

  assert.throws(
    () => loadConfig({ env: { BOT_WEBHOOK_URL: 'ftp://example.com/hook' }, cwd }),
    /http or https/
  );
  assert.throws(
    () => loadConfig({ env: { BOT_WEBHOOK_URL: 'https://user:pass@example.com/hook' }, cwd }),
    /username or password/
  );
  assert.throws(
    () =>
      loadConfig({
        env: { BOT_WEBHOOK_URL: 'https://example.com/hook', BOT_KEY_HEADER: 'Content-Type', BOT_WEBHOOK_KEY: 'k' },
        cwd,
      }),
    /cannot be Content-Type/
  );
  assert.throws(
    () =>
      loadConfig({
        env: {
          BOT_WEBHOOK_URL: 'https://example.com/hook',
          BOT_WEBHOOK_KEY: 'super-secret-value\nmore',
        },
        cwd,
      }),
    (err) => err instanceof ConfigError && !err.message.includes('super-secret-value')
  );
});

test('multiple bots require a real defaultBot and reject the shorthand mixed with bots', () => {
  const dir = tempDir();
  const file = writeJson(dir, 'bots.json', {
    defaultBot: 'missing',
    bots: {
      writer: { url: 'https://example.com/writer' },
      coder: { url: 'https://example.com/coder' },
    },
  });
  assert.throws(() => loadConfig({ configPath: file, env: {}, cwd: dir }), /defaultBot "missing"/);

  const config = loadConfig({
    env: {
      CLAUDE_BOT_BRIDGE_BOTS: JSON.stringify({
        writer: { name: 'Writer', url: 'https://example.com/writer' },
        coder: { name: 'Coder', url: 'https://example.com/coder', key: 'coder-secret-value' },
      }),
      CLAUDE_BOT_BRIDGE_DEFAULT_BOT: 'coder',
    },
    cwd: dir,
  });
  assert.equal(config.defaultBot, 'coder');
  assert.equal(config.bots.coder.keyPrefix, 'Bearer ');
  assert.deepEqual(Object.keys(config.bots).sort(), ['coder', 'writer']);

  assert.throws(
    () =>
      loadConfig({
        configPath: writeJson(dir, 'both.json', {
          url: 'https://example.com/one',
          bots: { other: { url: 'https://example.com/two' } },
        }),
        env: {},
        cwd: dir,
      }),
    /top-level "url" and "bots"/
  );
});

test('a missing config path and invalid JSON say what to fix', () => {
  const dir = tempDir();
  assert.throws(
    () => loadConfig({ argv: ['--config', 'nope.json'], env: {}, cwd: dir }),
    /Config file not found/
  );
  fs.writeFileSync(path.join(dir, 'bad.json'), '{');
  assert.throws(() => loadConfig({ argv: ['--config', 'bad.json'], env: {}, cwd: dir }), /not valid JSON/);
  assert.throws(() => loadConfig({ argv: ['--wat'], env: {}, cwd: dir }), /Unknown argument/);
});

test('BOT_TIMEOUT_MS overrides a per-bot file timeout and must be in range', () => {
  const dir = tempDir();
  const file = writeJson(dir, 't.json', {
    timeoutMs: 5000,
    bots: { assistant: { url: 'https://example.com/hook', timeoutMs: 9000 } },
  });
  const config = loadConfig({ configPath: file, env: { BOT_TIMEOUT_MS: '4000' }, cwd: dir });
  assert.equal(config.timeoutMs, 4000);
  assert.equal(config.bots.assistant.timeoutMs, 4000);
  assert.throws(
    () => loadConfig({ env: { BOT_WEBHOOK_URL: 'https://example.com/hook', BOT_TIMEOUT_MS: '50' }, cwd: dir }),
    /timeoutMs/
  );
});
