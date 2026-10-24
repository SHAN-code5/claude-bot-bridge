'use strict';

const { parseReplyBody } = require('./parse');

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

async function readLoop(bot, signal, options) {
  let delay = 500;
  while (!signal.aborted) {
    try {
      await readOnce(bot, signal, options);
      delay = 500;
    } catch (err) {
      if (signal.aborted || (err && err.name === 'AbortError')) return;
      if (options.log) options.log.error(`sse ${bot.id} disconnected: ${err.message || err}`);
      await wait(delay, signal);
      delay = Math.min(delay * 2, 15000);
    }
  }
}

async function readOnce(bot, signal, options) {
  const headers = { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' };
  if (bot.key) headers[bot.keyHeader] = `${bot.keyPrefix}${bot.key}`;
  const response = await options.fetchImpl(bot.sseUrl, { method: 'GET', headers, redirect: 'manual', signal });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}`);
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error('SSE response has no body');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = consumeEvents(buffer, (event) => {
      const replies = parseReplyBody(event.data, 'application/json', { source: 'sse', bot: bot.id });
      for (const reply of replies) {
        const saved = options.store.add(reply);
        if (saved && options.onReply) options.onReply(saved);
      }
    });
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
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

module.exports = { startSseClients, consumeEvents };
