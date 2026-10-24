'use strict';

const { postWebhook } = require('./webhook');

class RateLimiter {
  constructor(limit, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  take(id, now = Date.now()) {
    if (!this.limit || this.limit <= 0) return { ok: true, retryAfterMs: 0 };
    const recent = (this.hits.get(id) || []).filter((stamp) => now - stamp < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(id, recent);
      return { ok: false, retryAfterMs: Math.max(0, this.windowMs - (now - recent[0])) };
    }
    recent.push(now);
    this.hits.set(id, recent);
    return { ok: true, retryAfterMs: 0 };
  }
}

function hostAllowed(urlValue, allowedHosts) {
  if (!allowedHosts || allowedHosts.length === 0) return true;
  let url;
  try {
    url = new URL(urlValue);
  } catch {
    return false;
  }
  return allowedHosts.some((entry) => {
    const wanted = String(entry).trim().toLowerCase();
    return wanted === url.hostname || wanted === url.host;
  });
}

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * True when a Host header names the loopback interface. A DNS-rebinding page
 * reaches a loopback server with its own hostname in Host, so this rejects it.
 */
function loopbackHostHeader(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\[[^\]]+\]|[^:\[\]]+)(?::\d{1,5})?$/.exec(value.trim().toLowerCase());
  return Boolean(match) && LOOPBACK_NAMES.has(match[1]);
}

// A POST is only retried when the bot cannot have acted on it: it said so
// (429, 503), or the connection failed before the request was sent. A timeout
// or a 502/504 may come after the bot already handled the message.
function isRetryableStatus(status) {
  return status === 429 || status === 503;
}

function isRetryableError(err) {
  if (!err) return false;
  if (err.name === 'Cancelled') return false;
  if (err.status) return isRetryableStatus(err.status);
  return err.notSent === true;
}

async function sendWithPolicy({ bot, payload, fetchImpl, secrets, signal, rate, config }) {
  const gate = rate.take(bot.id);
  if (!gate.ok) {
    const error = new Error(
      `Rate limit for "${bot.id}": ${config.rateLimitPerMinute} requests per minute. Retry after ${gate.retryAfterMs}ms.`
    );
    error.code = 'RATE_LIMIT';
    throw error;
  }
  const maxRetries = config.maxRetries || 0;
  let attempt = 0;
  while (true) {
    try {
      return await postWebhook(bot, payload, { fetchImpl, secrets, signal });
    } catch (err) {
      if (!isRetryableError(err) || attempt >= maxRetries) throw err;
      const delay = (config.retryBaseMs || 250) * 2 ** attempt;
      attempt += 1;
      await delayFor(delay, signal);
    }
  }
}

function delayFor(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      const error = new Error('cancelled');
      error.name = 'Cancelled';
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error('cancelled');
      error.name = 'Cancelled';
      reject(error);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

module.exports = { RateLimiter, hostAllowed, loopbackHostHeader, sendWithPolicy, isRetryableStatus, isRetryableError };
