'use strict';

const { parseReplyBody } = require('./parse');
const { signHeaders } = require('./signing');
const { headerGet } = require('./webhook');

function startSseClients({ config, store, log, fetchImpl, onReply, signal }) {
  const stops = [];
  for (const bot of Object.values(config.bots)) {
    if (!bot.sseUrl) continue;
    stops.push(followBot(bot, { store, log, fetchImpl: fetchImpl || fetch, onReply, signal }));
  }
  return {
    async close() {
      await Promise.all(stops.map((stop) => stop()));
    },
  };
}

function followBot(bot, options) {
  const controller = new AbortController();
  const onParent = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onParent, { once: true });
  }
  const task = readLoop(bot, controller.signal, options);
  return async function stop() {
    controller.abort();
    if (options.signal) options.signal.removeEventListener('abort', onParent);
    try {
      await task;
    } catch {
      // The loop ends on abort.
    }
  };
}

const STOP_CODES = new Set(['SSE_AUTH', 'SSE_REDIRECT', 'SSE_TYPE']);

async function readLoop(bot, signal, options) {
  let delay = 500;
  while (!signal.aborted) {
    let events = 0;
    try {
      events = await readOnce(bot, signal, options);
    } catch (err) {
      if (signal.aborted || (err && err.name === 'AbortError')) return;
      if (err && STOP_CODES.has(err.code)) {
        if (options.log) options.log.error(`sse ${bot.id} stopped: ${err.message}`);
        return;
      }
      if (options.log) options.log.error(`sse ${bot.id} disconnected: ${err.message || err}`);
    }
    // Always pause before reconnecting. A stream that closes at once without
    // sending an event backs off instead of hammering the bot.
    if (events > 0) delay = 500;
    await wait(delay, signal);
    delay = Math.min(delay * 2, 15000);
  }
}

function sseHeaders(bot) {
  const headers = { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' };
  if (bot.key) headers[bot.keyHeader] = `${bot.keyPrefix}${bot.key}`;
  if (bot.signingSecret) Object.assign(headers, signHeaders(bot.signingSecret, ''));
  return headers;
}

async function openStream(bot, signal, fetchImpl) {
  const response = await fetchImpl(bot.sseUrl, { method: 'GET', headers: sseHeaders(bot), redirect: 'manual', signal });
  let error = null;
  if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
    error = new Error(`HTTP ${response.status}`);
    error.code = response.status < 400 ? 'SSE_REDIRECT' : 'SSE_AUTH';
  } else if (response.status < 200 || response.status >= 300) {
    error = new Error(`HTTP ${response.status}`);
  } else {
    const type = headerGet(response, 'content-type');
    if (type && !/^text\/event-stream\b/i.test(type.trim())) {
      error = new Error(`Content-Type is ${type.split(';')[0].trim()}, not text/event-stream`);
      error.code = 'SSE_TYPE';
    } else if (!response.body || typeof response.body.getReader !== 'function') {
      error = new Error('SSE response has no body');
    }
  }
  if (error) {
    await discard(response);
    throw error;
  }
  return response;
}

async function readOnce(bot, signal, options) {
  const response = await openStream(bot, signal, options.fetchImpl);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let events = 0;
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.length > 1024 * 1024) {
      buffer = '';
      if (options.log) options.log.error(`sse ${bot.id} dropped an oversized event`);
      continue;
    }
    buffer = consumeEvents(buffer, (event) => {
      events += 1;
      const replies = parseReplyBody(event.data, 'application/json', { source: 'sse', bot: bot.id });
      for (const reply of replies) {
        const saved = options.store.add(reply);
        if (saved && options.onReply) options.onReply(saved);
      }
    });
  }
  return events;
}

/**
 * Connect once and check the stream answers like SSE. Used by doctor.
 */
async function probeSse(bot, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await openStream(bot, controller.signal, fetchImpl);
    await discard(response);
    return { ok: true, detail: `HTTP ${response.status} text/event-stream` };
  } catch (err) {
    const timedOut = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
    return { ok: false, detail: timedOut ? `request timed out after ${timeoutMs}ms` : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function discard(response) {
  try {
    if (response.body && typeof response.body.cancel === 'function') await response.body.cancel();
  } catch {
    // Nothing left to release.
  }
}

function consumeEvents(buffer, onEvent) {
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop();
  for (const block of parts) {
    if (!block.trim()) continue;
    let eventName = 'message';
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      else if (line.startsWith('event:')) eventName = line.slice(6).trim();
    }
    if (data.length) onEvent({ event: eventName, data: data.join('\n') });
  }
  return rest || '';
}

function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

module.exports = { startSseClients, consumeEvents, probeSse };
