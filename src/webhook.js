'use strict';

const { parseReplyBody } = require('./parse');
const { redact } = require('./redact');

const VERSION = require('../package.json').version;

class HttpCallError extends Error {
  constructor(message, secrets) {
    super(redact(message, secrets || []));
    this.name = 'HttpCallError';
  }
}

async function postWebhook(bot, payload, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const secrets = options.secrets || [];
  const headers = {
    Accept: 'application/json, text/plain;q=0.8, */*;q=0.1',
    'User-Agent': `claude-bot-bridge/${VERSION}`,
  };
  if (bot.key) headers[bot.keyHeader] = `${bot.keyPrefix}${bot.key}`;
  headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetchImpl(bot.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      redirect: 'manual',
      signal: AbortSignal.timeout(bot.timeoutMs),
    });
  } catch (err) {
    throw new HttpCallError(
      `Webhook for "${bot.id}" failed: ${describeFetchError(err, bot.timeoutMs)}.`,
      secrets
    );
  }

  const text = await readBody(response, secrets, `Webhook for "${bot.id}"`);
  if (response.status >= 300 && response.status < 400) {
    throw new HttpCallError(
      `Webhook for "${bot.id}" returned HTTP ${response.status} redirect. The bridge does not follow redirects, so the secret is not sent to another host.`,
      secrets
    );
  }
  if (response.status < 200 || response.status >= 300) {
    const snippet = clip(text, 400);
    throw new HttpCallError(
      `Webhook for "${bot.id}" returned HTTP ${response.status}${snippet ? `: ${snippet}` : '.'}`,
      secrets
    );
  }
  return {
    status: response.status,
    contentType: headerGet(response, 'content-type'),
    text,
  };
}

async function pollReplies(bot, store, options = {}) {
  if (!bot.replyUrl) return [];
  const fetchImpl = options.fetchImpl || fetch;
  const secrets = options.secrets || [];
  let response;
  try {
    response = await fetchImpl(bot.replyUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain;q=0.8, */*;q=0.1',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        'User-Agent': `claude-bot-bridge/${VERSION}`,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(bot.timeoutMs),
    });
  } catch (err) {
    throw new HttpCallError(
      `Reply URL for "${bot.id}" failed: ${describeFetchError(err, bot.timeoutMs)}.`,
      secrets
    );
  }
  const text = await readBody(response, secrets, `Reply URL for "${bot.id}"`);
  if (response.status >= 300 && response.status < 400) {
    throw new HttpCallError(
      `Reply URL for "${bot.id}" returned HTTP ${response.status} redirect. The bridge does not follow redirects.`,
      secrets
    );
  }
  if (response.status < 200 || response.status >= 300) {
    const snippet = clip(text, 400);
    throw new HttpCallError(
      `Reply URL for "${bot.id}" returned HTTP ${response.status}${snippet ? `: ${snippet}` : '.'}`,
      secrets
    );
  }
  const parsed = parseReplyBody(text, headerGet(response, 'content-type'), {
    source: 'poll',
    bot: bot.id,
    nonce: options.nonce,
  });
  const added = [];
  for (const reply of parsed) {
    const stored = store.add(reply);
    if (stored) added.push(stored);
  }
  return added;
}

async function readBody(response, secrets, label) {
  try {
    return await response.text();
  } catch (err) {
    throw new HttpCallError(`${label} response could not be read: ${describeFetchError(err, 0)}.`, secrets);
  }
}

function describeFetchError(err, timeoutMs) {
  if (!err) return 'request failed';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') {
    return timeoutMs ? `request timed out after ${timeoutMs}ms` : 'request timed out';
  }
  const cause = err.cause && err.cause.message ? String(err.cause.message) : '';
  const message = err.message || 'request failed';
  if (cause && !message.includes(cause)) return `${message}: ${cause}`;
  return message;
}

function headerGet(response, name) {
  if (!response || !response.headers || typeof response.headers.get !== 'function') return '';
  return response.headers.get(name) || '';
}

function clip(text, max) {
  const oneLine = String(text || '').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max)}…`;
}

module.exports = { postWebhook, pollReplies, HttpCallError, clip };
