'use strict';

function createRuntime() {
  let relayStop = false;
  const listeners = new Set();
  return {
    requestStopRelay() {
      relayStop = true;
    },
    clearRelayStop() {
      relayStop = false;
    },
    shouldStop() {
      return relayStop;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(reply) {
      for (const listener of listeners) {
        try {
          listener(reply);
        } catch {
          // A listener must not break delivery to the others.
        }
      }
    },
  };
}

function notificationFor(reply) {
  const text = String(reply.text || '').slice(0, 500);
  return {
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: {
      level: 'info',
      logger: 'claude-bot-bridge',
      data: `Reply via ${reply.source || 'unknown'} from ${reply.bot || 'bot'} thread ${reply.threadId || 'unscoped'}: ${text}`,
    },
  };
}

function createNotifyBuffer(write, limit = 50) {
  let ready = false;
  const pending = [];
  return {
    markReady() {
      if (ready) return;
      ready = true;
      while (pending.length) write(pending.shift());
    },
    send(message) {
      if (!ready) {
        pending.push(message);
        if (pending.length > limit) pending.shift();
        return;
      }
      write(message);
    },
  };
}

module.exports = { createRuntime, notificationFor, createNotifyBuffer };
