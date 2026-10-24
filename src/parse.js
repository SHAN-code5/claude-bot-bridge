'use strict';

const crypto = require('node:crypto');

const ACK_TEXT = /^(ok|okay|accepted|queued|success|created)\.?$/i;

/**
 * Turn a webhook or reply-URL body into zero or more reply objects.
 * Plain-text bodies that are only an ack ("ok", "accepted", …) are ignored.
 * An explicit JSON field such as {"reply":"ok"} is kept.
 */
function parseReplyBody(text, contentType, defaults = {}) {
  const raw = text == null ? '' : String(text);
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const type = (contentType || '').toLowerCase();
  const looksJson = type.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[');
  if (looksJson) {
    try {
      return repliesFromJson(JSON.parse(trimmed), defaults);
    } catch {
      if (type.includes('json')) return [];
    }
  }

  if (ACK_TEXT.test(trimmed)) return [];
  const reply = one(
    { text: trimmed },
    defaults
  );
  return reply ? [reply] : [];
}

function repliesFromJson(data, defaults) {
  if (data == null) return [];
  if (typeof data === 'string') {
    const text = data.trim();
    if (!text || ACK_TEXT.test(text)) return [];
    const reply = one({ text }, defaults);
    return reply ? [reply] : [];
  }
  if (Array.isArray(data)) {
    return data.flatMap((item) => repliesFromJson(item, defaults));
  }
  if (typeof data !== 'object') return [];

  if (Array.isArray(data.replies)) return data.replies.flatMap((item) => repliesFromJson(item, defaults));
  if (Array.isArray(data.messages)) return data.messages.flatMap((item) => repliesFromJson(item, defaults));

  const explicit = ['reply', 'message', 'text', 'content'].some((key) =>
    Object.prototype.hasOwnProperty.call(data, key)
  );
  const text = firstString(data.reply, data.message, data.text, data.content);
  if (!text) return [];
  if (!explicit && ACK_TEXT.test(text)) return [];

  const reply = one(
    {
      id: firstString(data.id),
      text,
      threadId: firstString(data.threadId, data.thread, data.conversationId),
      messageId: firstString(data.messageId, data.inReplyTo),
      at: firstString(data.at, data.sentAt, data.timestamp, data.time),
      bot: firstString(data.bot, data.botId),
    },
    defaults
  );
  return reply ? [reply] : [];
}

function one(fields, defaults) {
  const text = String(fields.text || '').trim();
  if (!text) return null;
  const bot = fields.bot || defaults.bot || null;
  const threadId = fields.threadId || defaults.threadId || null;
  let id;
  if (fields.id) id = `${defaults.source || 'reply'}:${bot || '_'}:${fields.id}`;
  else if (defaults.source === 'inbox') id = `in_${crypto.randomBytes(8).toString('hex')}`;
  else id = hashId(defaults.source, bot, threadId, text, fields.at, defaults.nonce);

  return {
    id,
    bot,
    threadId,
    messageId: fields.messageId || null,
    text,
    source: defaults.source || 'unknown',
    at: fields.at || null,
  };
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function hashId(...parts) {
  const hash = crypto
    .createHash('sha256')
    .update(parts.map((part) => (part == null ? '' : String(part))).join('\n'))
    .digest('hex')
    .slice(0, 24);
  return `rpl_${hash}`;
}

module.exports = { parseReplyBody, hashId };
