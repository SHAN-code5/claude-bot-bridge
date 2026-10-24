'use strict';

const { redact } = require('./redact');

// Echo a protocol version we know. Anything else gets the widely deployed
// 2025-03-26 response, which still speaks tools/list and tools/call.
const SUPPORTED_VERSIONS = new Set(['2024-10-07', '2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const DEFAULT_VERSION = '2025-03-26';

function createHandler({ service, resources, serverInfo, instructions, secrets }) {
  const library = resources || {
    list() {
      return [];
    },
    templates() {
      return [];
    },
    read() {
      return null;
    },
  };
  return async function handle(message, signal) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return rpcError(null, -32600, 'Invalid Request');
    }
    const hasId = message.id !== undefined && message.id !== null;
    const { method } = message;
    if (typeof method !== 'string') {
      return hasId ? rpcError(message.id, -32600, 'Invalid Request') : null;
    }
    if (method.startsWith('notifications/')) return null;

    try {
      if (method === 'initialize') {
        if (!hasId) return null;
        const requested = message.params && message.params.protocolVersion;
        const protocolVersion = SUPPORTED_VERSIONS.has(requested) ? requested : DEFAULT_VERSION;
        return rpcResult(message.id, {
          protocolVersion,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            logging: {},
          },
          serverInfo,
          instructions,
        });
      }
      if (method === 'ping' || method === 'initialized' || method === 'logging/setLevel') {
        return hasId ? rpcResult(message.id, {}) : null;
      }
      if (method === 'resources/list') {
        if (!hasId) return null;
        return rpcResult(message.id, { resources: library.list() });
      }
      if (method === 'resources/templates/list') {
        if (!hasId) return null;
        return rpcResult(message.id, { resourceTemplates: library.templates() });
      }
      if (method === 'resources/read') {
        if (!hasId) return null;
        const uri = message.params && message.params.uri;
        if (typeof uri !== 'string' || !uri) return rpcError(message.id, -32602, 'Invalid params: uri is required');
        const found = library.read(uri);
        if (!found) return rpcError(message.id, -32002, `Resource not found: ${uri}`);
        return rpcResult(message.id, {
          contents: [{ uri: found.uri, mimeType: found.mimeType, text: found.text }],
        });
      }
      if (method === 'tools/list') {
        if (!hasId) return null;
        return rpcResult(message.id, { tools: service.definitions });
      }
      if (method === 'tools/call') {
        if (!hasId) return null;
        const params = message.params;
        if (!params || typeof params !== 'object' || typeof params.name !== 'string' || !params.name) {
          return rpcError(message.id, -32602, 'Invalid params: tool name is required');
        }
        if (
          params.arguments != null &&
          (typeof params.arguments !== 'object' || Array.isArray(params.arguments))
        ) {
          return rpcError(message.id, -32602, 'Invalid params: arguments must be an object');
        }
        const toolResult = await service.call(params.name, params.arguments || {}, { signal });
        return rpcResult(message.id, toolResult);
      }
      if (!hasId) return null;
      return rpcError(message.id, -32601, `Method not found: ${method}`);
    } catch (err) {
      if (err && err.name === 'Cancelled') throw err;
      if (!hasId) return null;
      const messageText = redact(err && err.message ? err.message : 'Internal error', secrets || []);
      return rpcError(message.id, -32603, messageText);
    }
  };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

module.exports = { createHandler, SUPPORTED_VERSIONS, DEFAULT_VERSION };
