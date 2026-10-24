'use strict';

const { parseReplyBody } = require('./parse');
const { redact } = require('./redact');

const VERSION = require('../package.json').version;
const MAX_HTTP_BODY = 1024 * 1024;

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

  const deadline = requestSignal(bot.timeoutMs, options.signal);
  try {
    let response;
    try {
      response = await fetchImpl(bot.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        redirect: 'manual',
        signal: deadline.signal,
      });
    } catch (err) {
      if (options.signal && options.signal.aborted) throw cancelled();
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
  } finally {
    deadline.done();
  }
}

async function pollReplies(bot, store, options = {}) {
  if (!bot.replyUrl) return [];
  const fetchImpl = options.fetchImpl || fetch;
  const secrets = options.secrets || [];
  const deadline = requestSignal(bot.timeoutMs, options.signal);
  try {
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
        signal: deadline.signal,
      });
    } catch (err) {
      if (options.signal && options.signal.aborted) throw cancelled();
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
  } finally {
    deadline.done();
  }
}

async function readBody(response, secrets, label) {
  try {
    return await readLimited(response, MAX_HTTP_BODY);
  } catch (err) {
    if (err && err.code === 'BODY_TOO_LARGE') {
      throw new HttpCallError(`${label} response is larger than 1 MiB and was rejected.`, secrets);
    }
    throw new HttpCallError(`${label} response could not be read: ${describeFetchError(err, 0)}.`, secrets);
  }
}

async function readLimited(response, max) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text) > max) {
      const error = new Error('response too large');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        const error = new Error('response too large');
        error.code = 'BODY_TOO_LARGE';
        throw error;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The body is already finished or cancelled.
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

function requestSignal(timeoutMs, parent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  const onParentAbort = () => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener('abort', onParentAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      if (parent) parent.removeEventListener('abort', onParentAbort);
    },
  };
}

function cancelled() {
  const error = new Error('cancelled');
  error.name = 'Cancelled';
  return error;
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

module.exports = { postWebhook, pollReplies, HttpCallError, clip, MAX_HTTP_BODY };
