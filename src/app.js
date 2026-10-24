'use strict';

const { ReplyStore } = require('./store');
const { startInbox, advertisedUrl } = require('./inbox');
const { createService, sessionDelivery } = require('./tools');
const { RateLimiter } = require('./policy');
const { createHandler } = require('./mcp');
const { createResources } = require('./resources');
const { createRuntime } = require('./runtime');
const { startSseClients } = require('./sse');
const { startDashboard } = require('./dashboard');

const pkg = require('../package.json');

async function createApp({ config, log, instructions, fetchImpl }) {
  let store;
  try {
    store = new ReplyStore({ file: config.stateFile, secrets: config.secrets, onError: (err) => log.error(err.message) });
  } catch (err) {
    throw new Error(err.message);
  }
  const runtime = createRuntime();
  let inbox = null;
  if (config.inbox.enabled) {
    try {
      inbox = await startInbox({
        config,
        store,
        log,
        onReply: (reply) => runtime.emit(reply),
      });
    } catch (err) {
      const reason = err && err.code === 'EADDRINUSE' ? `port ${config.inbox.port} is already in use` : err.message;
      throw new Error(`could not start inbox on ${config.inbox.host}:${config.inbox.port} (${reason}).`);
    }
    config.inbox.localUrl = inbox.localUrl;
    config.inbox.port = inbox.port;
    config.inbox.advertisedUrl = advertisedUrl(config.inbox.publicUrl, config.inbox.path, inbox.localUrl);
    if (config.inbox.host === '0.0.0.0' || config.inbox.host === '::') {
      log.info(
        config.inbox.token
          ? 'inbox is bound to all interfaces; the token is required'
          : 'inbox is bound to all interfaces and has no token; set BOT_INBOX_TOKEN before exposing it'
      );
    } else if (!config.inbox.token) {
      log.info('inbox has no token; that is fine on localhost. Set one before opening a tunnel.');
    }
  }

  const sse = startSseClients({
    config,
    store,
    log,
    fetchImpl,
    onReply: (reply) => runtime.emit(reply),
  });
  // Shared by every service so HTTP sessions cannot multiply the rate limit.
  const rateLimiter = new RateLimiter(config.rateLimitPerMinute || 0);
  const etags = new Map();
  const serviceFor = (delivery) =>
    createService({ config, store, log, secrets: config.secrets, fetchImpl, runtime, rateLimiter, etags, delivery });
  const resources = createResources(store, config);
  const handlerFor = (service) =>
    createHandler({
      service,
      resources,
      secrets: config.secrets,
      serverInfo: { name: pkg.name, version: pkg.version },
      instructions,
    });
  const service = serviceFor(undefined);
  const handler = handlerFor(service);

  let dashboard = null;
  if (config.dashboard && config.dashboard.enabled) {
    assertLoopback(config.dashboard.host, 'dashboard');
    dashboard = await startDashboard({
      store,
      config,
      host: config.dashboard.host,
      port: config.dashboard.port,
      log,
    });
  }

  return {
    config,
    store,
    inbox,
    sse,
    service,
    handler,
    runtime,
    dashboard,
    // One handler per HTTP session, each with its own delivery tracking.
    createSessionHandler() {
      return handlerFor(serviceFor(sessionDelivery(store)));
    },
    async close() {
      const jobs = [];
      if (inbox) jobs.push(inbox.close());
      if (dashboard) jobs.push(dashboard.close());
      jobs.push(sse.close());
      try {
        await Promise.all(jobs);
      } finally {
        try {
          store.flush();
        } catch (err) {
          log.error(`could not write state file: ${err.message}`);
        }
      }
    },
  };
}

function assertLoopback(host, label) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`${label} must bind to 127.0.0.1, localhost, or ::1.`);
  }
}

module.exports = { createApp, assertLoopback };
