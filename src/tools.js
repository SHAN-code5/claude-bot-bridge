'use strict';

const crypto = require('node:crypto');
const { parseReplyBody } = require('./parse');
const { postWebhook, pollReplies, HttpCallError } = require('./webhook');
const { redact } = require('./redact');

const THREAD_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_TEXT = 100_000;

class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolError';
  }
}

function createService(options) {
  const config = options.config;
  const store = options.store;
  const fetchImpl = options.fetchImpl || fetch;
  const secrets = options.secrets || config.secrets || [];
  const log = options.log || { info() {}, error() {} };
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const definitions = toolDefinitions(config);

  async function call(name, args) {
    const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    try {
      let text;
      if (name === 'list_bots') text = listBots();
      else if (name === 'send_message') text = await sendMessage(input);
      else if (name === 'get_replies') text = await getReplies(input);
      else if (name === 'wait_for_reply') text = await waitForReply(input);
      else {
        return fail(`Unknown tool "${name}". Tools: ${definitions.map((tool) => tool.name).join(', ')}.`);
      }
      return ok(text);
    } catch (err) {
      const message = err && err.message ? err.message : 'Unexpected error';
      log.error(`${name} failed: ${message}`);
      if (err instanceof ToolError || err instanceof HttpCallError) return fail(message);
      return fail(message);
    }
  }

  function ok(text) {
    return { content: [{ type: 'text', text: redact(text, secrets) }], isError: false };
  }

  function fail(text) {
    return { content: [{ type: 'text', text: redact(text, secrets) }], isError: true };
  }

  function listBots() {
    const lines = [`Default bot: ${config.defaultBot}`, `From: ${config.from}`, ''];
    for (const bot of Object.values(config.bots)) {
      lines.push(`${bot.id} — ${bot.name}`);
      lines.push(`  webhook: ${bot.url}`);
      lines.push(`  auth: ${bot.key ? `header ${bot.keyHeader} is set` : 'none'}`);
      lines.push(`  reply poll: ${bot.replyUrl || 'not configured'}`);
    }
    lines.push('');
    if (config.inbox && config.inbox.enabled) {
      lines.push(`Inbox: ${config.inbox.advertisedUrl || config.inbox.localUrl || 'enabled, waiting for the socket'}`);
      if (config.inbox.publicUrl && config.inbox.localUrl && config.inbox.advertisedUrl !== config.inbox.localUrl) {
        lines.push(`Inbox local: ${config.inbox.localUrl}`);
      }
      lines.push(`Inbox token: ${config.inbox.token ? 'required (not shown)' : 'not set'}`);
      lines.push('A remote bot can only reach the inbox through a tunnel. Set inbox.publicUrl to that tunnel URL.');
    } else {
      lines.push('Inbox: off');
    }
    lines.push('');
    lines.push('Send with send_message. Read what is already available with get_replies. Block for a new reply with wait_for_reply.');
    return lines.join('\n');
  }

  async function sendMessage(args) {
    const message = requireText(args.message, 'message');
    const context = args.context == null || args.context === ''
      ? ''
      : requireText(args.context, 'context', { allowEmpty: true });
    const threadId = args.threadId ? requireId(args.threadId, 'threadId') : newId('thr');
    const bot = resolveBot(config, args.bot);
    const messageId = newId('msg');
    const payload = {
      from: config.from,
      message,
      context,
      sentAt: new Date().toISOString(),
      threadId,
      messageId,
      bot: bot.id,
      replyChannels: buildReplyChannels(config, bot, threadId),
    };
    const response = await postWebhook(bot, payload, { fetchImpl, secrets });
    const parsed = parseReplyBody(response.text, response.contentType, {
      source: 'sync',
      bot: bot.id,
      threadId,
      nonce: messageId,
    });
    const shown = [];
    for (const reply of parsed) {
      const saved = store.add({ ...reply, delivered: true });
      shown.push(saved || reply);
    }
    log.info(`sent bot=${bot.id} status=${response.status} thread=${threadId}`);
    return formatSend({ bot, threadId, messageId, status: response.status, replies: shown });
  }

  async function getReplies(args) {
    const bot = args.bot == null || args.bot === '' ? null : resolveBot(config, args.bot);
    const threadId = args.threadId ? requireId(args.threadId, 'threadId') : null;
    const sinceMs = args.since == null || args.since === '' ? null : parseSince(args.since);
    const limit = clampInt(args.limit, 20, 1, 100, 'limit');
    const botsToPoll = botsForPoll(config, bot);
    const pollErrors = [];
    await pollBots(botsToPoll, pollErrors);
    const matched = store.list({
      bot: bot ? bot.id : null,
      threadId,
      sinceMs,
    });
    const slice = matched.slice(-limit);
    return formatReplies({
      slice,
      total: matched.length,
      threadId,
      bot,
      pollErrors,
      polled: botsToPoll.length > 0,
    });
  }

  async function waitForReply(args) {
    const bot = args.bot == null || args.bot === '' ? null : resolveBot(config, args.bot);
    const threadId = args.threadId ? requireId(args.threadId, 'threadId') : null;
    const timeoutMs = clampInt(args.timeoutMs == null ? 120000 : args.timeoutMs, 120000, 0, config.maxWaitMs, 'timeoutMs');
    const interval = clampInt(args.pollIntervalMs == null ? 2000 : args.pollIntervalMs, 2000, 200, 30000, 'pollIntervalMs');
    const sinceMs = args.since == null || args.since === '' ? null : parseSince(args.since);
    const includeExisting = optionalBool(args.includeExisting, 'includeExisting');
    const ignoreExisting = optionalBool(args.ignoreExisting, 'ignoreExisting');
    if (includeExisting && ignoreExisting) {
      throw new ToolError('Pass only one of includeExisting or ignoreExisting.');
    }

    // Poll snapshots that already exist (or appear on the first fetch) are not
    // "new". A stale reply file would otherwise look like the bot just answered.
    // Inbox posts are events: they still count unless ignoreExisting is set.
    const exclude = new Set();
    if (ignoreExisting) {
      for (const id of store.ids()) exclude.add(id);
    }
    const pollErrors = [];
    const started = Date.now();
    const filter = () => ({
      bot: bot ? bot.id : null,
      threadId,
      sinceMs,
      exclude,
    });

    await pollBots(botsForPoll(config, bot), pollErrors);
    if (!includeExisting) {
      for (const reply of store.list()) {
        if (reply.source === 'poll') exclude.add(reply.id);
      }
    }

    const deliver = (reply) => {
      store.markDelivered(reply.id);
      return formatWait(reply, Date.now() - started);
    };

    const immediate = store.nextUndelivered(filter());
    if (immediate) return deliver(immediate);

    const channels = channelsFor(config, bot);
    if (!channels.poll && !channels.inbox) return noChannelText(bot, threadId);

    const deadline = started + timeoutMs;
    let nextPollAt = Date.now() + interval;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      // Inbox posts are checked on a short slice. Reply URLs use pollIntervalMs.
      await sleep(Math.min(200, interval, remaining));
      const duringSleep = store.nextUndelivered(filter());
      if (duringSleep) return deliver(duringSleep);
      if (Date.now() >= deadline) break;
      if (Date.now() + 20 >= nextPollAt) {
        await pollBots(botsForPoll(config, bot), pollErrors);
        nextPollAt = Date.now() + interval;
        const found = store.nextUndelivered(filter());
        if (found) return deliver(found);
      }
    }

    return timeoutText({ timeoutMs, threadId, bot, pollErrors });
  }

  async function pollBots(bots, pollErrors) {
    for (const item of bots) {
      try {
        await pollReplies(item, store, { fetchImpl, secrets });
      } catch (err) {
        const line = `${item.id}: ${err.message}`;
        const index = pollErrors.findIndex((entry) => entry.startsWith(`${item.id}:`));
        if (index >= 0) pollErrors[index] = line;
        else pollErrors.push(line);
      }
    }
  }

  return { definitions, call };
}

function toolDefinitions(config) {
  return [
    {
      name: 'list_bots',
      title: 'List bots',
      description:
        'List configured bots and reply channels. Secrets are not included. Call this when the bot id is unclear.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'send_message',
      title: 'Send message',
      description:
        'Send a message to a configured bot webhook. If the HTTP response contains a reply, it is returned here. Otherwise keep the threadId and call get_replies or wait_for_reply. Reuse threadId to continue the same conversation.',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Message for the bot.' },
          bot: { type: 'string', description: 'Bot id from list_bots. Omit to use the default bot.' },
          threadId: {
            type: 'string',
            description: 'Existing conversation id. Omit to start a new thread.',
          },
          context: { type: 'string', description: 'Extra context that is not the main message.' },
        },
        required: ['message'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    {
      name: 'get_replies',
      title: 'Get replies',
      description:
        'Read replies already received, and poll each configured reply URL once. A reply URL without timestamps may still contain older text from before this conversation. Inbox posts are events that arrived at the bridge.',
      inputSchema: {
        type: 'object',
        properties: {
          bot: { type: 'string', description: 'Bot id. Omit to include every bot.' },
          threadId: { type: 'string', description: 'Only this conversation. Omit for every thread.' },
          since: { type: 'string', description: 'Only replies at or after this ISO-8601 time.' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            description: 'How many of the latest replies to return. Default 20.',
          },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    {
      name: 'wait_for_reply',
      title: 'Wait for reply',
      description: `Poll until a new reply arrives or the timeout hits. Default timeout is 120000 ms. Maximum is ${config.maxWaitMs} ms. Text already on a reply URL when the wait starts is ignored, so a stale file is not treated as a fresh answer; call get_replies to read it. Set includeExisting true to accept that current text. The bot cannot push into the chat while this tool is not running.`,
      inputSchema: {
        type: 'object',
        properties: {
          bot: { type: 'string', description: 'Bot id. Omit to watch the default channels.' },
          threadId: { type: 'string', description: 'Thread returned by send_message.' },
          timeoutMs: {
            type: 'integer',
            description: `How long to wait in milliseconds. Default 120000. Maximum ${config.maxWaitMs}.`,
          },
          pollIntervalMs: {
            type: 'integer',
            description: 'How often to poll in milliseconds. Default 2000. Minimum 200. Maximum 30000.',
          },
          since: { type: 'string', description: 'Ignore replies earlier than this ISO-8601 time.' },
          includeExisting: {
            type: 'boolean',
            description: 'When true, reply-URL content that is already present counts as the reply.',
          },
          ignoreExisting: {
            type: 'boolean',
            description: 'When true, only replies that arrive after this call starts are returned.',
          },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
  ];
}

function buildReplyChannels(config, bot, threadId) {
  const channels = [
    {
      type: 'response',
      threadId,
      hint: 'Return JSON {"reply":"...","threadId":"..."} in the HTTP response for an immediate reply.',
    },
  ];
  if (config.inbox && config.inbox.enabled && config.inbox.advertisedUrl) {
    const channel = {
      type: 'inbox',
      url: config.inbox.advertisedUrl,
      threadId,
      bot: bot.id,
      hint: 'POST JSON {"message":"...","threadId":"...","bot":"..."} to url.',
    };
    if (config.inbox.token) channel.auth = 'Send the inbox token as Authorization: Bearer <token> or X-Bridge-Token. The token is not included here.';
    channels.push(channel);
  }
  if (bot.replyUrl) {
    channels.push({
      type: 'poll',
      url: bot.replyUrl,
      threadId,
      hint: 'Serve a GET with {"replies":[{"id","threadId","message","at"}]} or plain text.',
    });
  }
  return channels;
}

function botsForPoll(config, bot) {
  if (bot) return bot.replyUrl ? [bot] : [];
  return Object.values(config.bots).filter((item) => item.replyUrl);
}

function channelsFor(config, bot) {
  const bots = bot ? [bot] : Object.values(config.bots);
  return {
    poll: bots.some((item) => item.replyUrl),
    inbox: Boolean(config.inbox && config.inbox.enabled),
  };
}

function resolveBot(config, name) {
  if (name == null || name === '') {
    const bot = config.bots[config.defaultBot];
    if (!bot) throw new ToolError('No default bot is configured.');
    return bot;
  }
  if (typeof name !== 'string') throw new ToolError('bot must be a string.');
  const bot = config.bots[name];
  if (!bot) {
    const known = Object.keys(config.bots).join(', ') || '(none)';
    throw new ToolError(`Unknown bot "${name}". Configured bots: ${known}.`);
  }
  return bot;
}

function requireText(value, label, { allowEmpty = false } = {}) {
  if (value == null) throw new ToolError(`${label} is required.`);
  if (typeof value !== 'string') throw new ToolError(`${label} must be a string.`);
  if (!allowEmpty && !value.trim()) throw new ToolError(`${label} is required.`);
  if (value.length > MAX_TEXT) throw new ToolError(`${label} is longer than ${MAX_TEXT} characters.`);
  return value;
}

function requireId(value, label) {
  if (typeof value !== 'string' || !THREAD_ID_RE.test(value)) {
    throw new ToolError(`${label} must be 1–128 characters: letters, numbers, and _ . : -`);
  }
  return value;
}

function optionalBool(value, label) {
  if (value == null) return false;
  if (typeof value !== 'boolean') throw new ToolError(`${label} must be a boolean.`);
  return value;
}

function parseSince(value) {
  if (typeof value !== 'string') throw new ToolError('since must be an ISO-8601 timestamp.');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new ToolError('since must be an ISO-8601 timestamp.');
  return ms;
}

function clampInt(value, fallback, min, max, label) {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ToolError(`${label} must be an integer.`);
  }
  if (value < min || value > max) {
    throw new ToolError(`${label} must be from ${min} to ${max}.`);
  }
  return value;
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function formatSend({ bot, threadId, messageId, status, replies }) {
  const lines = [
    `Sent to "${bot.name}" (${bot.id}).`,
    `threadId: ${threadId}`,
    `messageId: ${messageId}`,
    `status: ${status}`,
  ];
  if (replies.length === 0) {
    lines.push('');
    lines.push('No reply in the webhook response.');
    lines.push(`Call get_replies or wait_for_reply with threadId "${threadId}".`);
  } else {
    for (const reply of replies) {
      lines.push('');
      lines.push(`Reply (${reply.source || 'sync'}):`);
      lines.push(reply.text);
    }
  }
  return lines.join('\n');
}

function formatReplies({ slice, total, threadId, bot, pollErrors, polled }) {
  const who = [threadId ? `thread ${threadId}` : null, bot ? `bot ${bot.id}` : null].filter(Boolean).join(', ');
  if (total === 0) {
    const lines = [`No replies yet${who ? ` for ${who}` : ''}.`];
    if (polled && pollErrors.length === 0) lines.push('Polled the reply URL. Nothing new was there.');
    for (const error of pollErrors) lines.push(`Poll error: ${error}`);
    return lines.join('\n');
  }
  const noun = total === 1 ? 'reply' : 'replies';
  const lines = [
    `${total} ${noun}${who ? ` for ${who}` : ''}${total > slice.length ? ` (showing latest ${slice.length})` : ''}:`,
  ];
  slice.forEach((reply, index) => {
    lines.push('');
    lines.push(
      `${index + 1}. ${reply.source} ${reply.at || reply.receivedAt} id=${reply.id} thread=${reply.threadId || '-'} bot=${reply.bot || '-'}`
    );
    lines.push(reply.text);
  });
  if (slice.some((reply) => reply.source === 'poll' && !reply.at)) {
    lines.push('');
    lines.push('Note: a polled reply without a timestamp may already have been in the file before this conversation.');
  }
  for (const error of pollErrors) lines.push(`Poll error: ${error}`);
  return lines.join('\n');
}

function formatWait(reply, waitedMs) {
  return [
    `Reply via ${reply.source} after ${waitedMs}ms.`,
    `bot: ${reply.bot || '-'}`,
    `threadId: ${reply.threadId || '-'}`,
    `id: ${reply.id}`,
    '',
    reply.text,
  ].join('\n');
}

function noChannelText(bot, threadId) {
  return [
    'No reply is waiting, and there is no reply URL or inbox to watch.',
    'Have the webhook respond with {"reply":"..."}, or configure a replyUrl or the inbox.',
    bot ? `bot: ${bot.id}` : null,
    threadId ? `threadId: ${threadId}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function timeoutText({ timeoutMs, threadId, bot, pollErrors }) {
  const lines = [
    `No new reply arrived within ${timeoutMs}ms.`,
    threadId ? `threadId: ${threadId}` : null,
    bot ? `bot: ${bot.id}` : null,
    'Call get_replies to read anything already stored, including older reply-URL contents.',
    'Ask the user before waiting again.',
  ];
  for (const error of pollErrors) lines.push(`Poll error: ${error}`);
  return lines.filter((line) => line != null).join('\n');
}

module.exports = { createService, ToolError };
