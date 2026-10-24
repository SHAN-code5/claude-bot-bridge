'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { redact } = require('./redact');

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const BOT_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const RESERVED_HEADERS = new Set([
  'content-type',
  'accept',
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'user-agent',
]);

function parseArgv(argv) {
  const out = { config: null, help: false, version: false };
  const args = argv || [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--help' || token === '-h') {
      out.help = true;
    } else if (token === '--version' || token === '-V') {
      out.version = true;
    } else if (token === '--config') {
      const value = args[i + 1];
      if (!value || value.startsWith('-')) throw new ConfigError('Missing value for --config.');
      out.config = value;
      i += 1;
    } else if (token.startsWith('--config=')) {
      out.config = token.slice('--config='.length);
      if (!out.config) throw new ConfigError('Missing value for --config.');
    } else {
      throw new ConfigError(`Unknown argument "${token}". Run with --help.`);
    }
  }
  return out;
}

function loadConfig(options = {}) {
  const env = options.env || {};
  const cwd = options.cwd || process.cwd();
  const existsSync = options.existsSync || fs.existsSync;
  const readFileSync = options.readFileSync || fs.readFileSync;
  const configPath = resolveConfigPath(options, cwd, existsSync);

  let fileRaw = null;
  if (configPath) {
    fileRaw = readConfigFile(configPath, readFileSync, env);
  }

  const normalized = fileRaw ? normalizeFile(fileRaw) : emptyConfig();
  applyEnv(normalized, env);

  if (Object.keys(normalized.bots).length === 0) {
    throw new ConfigError(
      [
        'No bot configured.',
        'Set BOT_WEBHOOK_URL (and optionally BOT_WEBHOOK_KEY), or pass --config <file>.',
        'See examples/config.example.json.',
      ].join('\n')
    );
  }

  if (normalized.stateFile) normalized.stateFile = path.resolve(cwd, normalized.stateFile);
  finalizeBots(normalized, env);
  validate(normalized);
  return normalized;
}

function resolveConfigPath(options, cwd, existsSync) {
  if (options.configPath) return path.resolve(cwd, options.configPath);
  if (options.argv && options.argv.length) {
    const args = parseArgv(options.argv);
    if (args.config) return path.resolve(cwd, args.config);
  }
  if (options.env && options.env.CLAUDE_BOT_BRIDGE_CONFIG) {
    return path.resolve(cwd, options.env.CLAUDE_BOT_BRIDGE_CONFIG);
  }
  const local = path.join(cwd, 'claude-bot-bridge.config.json');
  if (existsSync(local)) return local;
  return null;
}

function readConfigFile(configPath, readFileSync, env) {
  let text;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new ConfigError(
        `Config file not found: ${configPath}\nPass a real path with --config, or set BOT_WEBHOOK_URL.`
      );
    }
    throw new ConfigError(`Could not read config file ${configPath}: ${err.message}`);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`Config file is not valid JSON (${configPath}). ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`Config file must contain a JSON object (${configPath}).`);
  }
  return interpolateTree(parsed, env, 'file');
}

function emptyConfig() {
  return {
    from: 'Claude',
    defaultBot: null,
    stateFile: null,
    maxWaitMs: 180000,
    timeoutMs: 30000,
    inbox: {
      enabled: false,
      host: '127.0.0.1',
      port: 8787,
      path: '/reply',
      token: null,
      publicUrl: null,
      localUrl: null,
      advertisedUrl: null,
    },
    bots: {},
  };
}

function normalizeFile(raw) {
  if (raw.url && raw.bots) {
    throw new ConfigError(
      'Config has both a top-level "url" and "bots". Use the shorthand only for one bot, or "bots" for several.'
    );
  }
  const cfg = emptyConfig();
  if (typeof raw.from === 'string' && raw.from.trim()) cfg.from = raw.from.trim();
  if (typeof raw.defaultBot === 'string' && raw.defaultBot.trim()) cfg.defaultBot = raw.defaultBot.trim();
  if (typeof raw.stateFile === 'string' && raw.stateFile.trim()) cfg.stateFile = raw.stateFile.trim();
  if (raw.maxWaitMs != null) cfg.maxWaitMs = raw.maxWaitMs;
  if (raw.timeoutMs != null) cfg.timeoutMs = raw.timeoutMs;
  if (raw.inbox && typeof raw.inbox === 'object' && !Array.isArray(raw.inbox)) {
    applyInbox(cfg.inbox, raw.inbox);
  }
  if (raw.bots != null) {
    if (typeof raw.bots !== 'object' || Array.isArray(raw.bots)) {
      throw new ConfigError('"bots" must be a JSON object of bot id → settings.');
    }
    for (const [id, bot] of Object.entries(raw.bots)) {
      cfg.bots[id] = normalizeBot(id, bot);
    }
  }
  if (raw.url) {
    const id = cfg.defaultBot || 'default';
    cfg.bots[id] = normalizeBot(id, {
      name: raw.name,
      url: raw.url,
      key: raw.key,
      keyHeader: raw.keyHeader,
      keyPrefix: raw.keyPrefix,
      replyUrl: raw.replyUrl,
      timeoutMs: raw.timeoutMs,
    });
    if (!cfg.defaultBot) cfg.defaultBot = id;
  }
  return cfg;
}

function applyInbox(inbox, raw) {
  if (raw.enabled != null) inbox.enabled = asBool(raw.enabled, 'inbox.enabled');
  if (typeof raw.host === 'string' && raw.host.trim()) inbox.host = raw.host.trim();
  if (raw.port != null) inbox.port = raw.port;
  if (typeof raw.path === 'string' && raw.path.trim()) inbox.path = normalizeInboxPath(raw.path);
  if (typeof raw.token === 'string' && raw.token) inbox.token = raw.token;
  if (typeof raw.publicUrl === 'string' && raw.publicUrl.trim()) inbox.publicUrl = raw.publicUrl.trim();
}

function applyEnv(cfg, env) {
  const from = env.BOT_FROM || env.CLAUDE_BOT_BRIDGE_FROM;
  if (from) cfg.from = String(from);
  if (env.CLAUDE_BOT_BRIDGE_STATE) cfg.stateFile = env.CLAUDE_BOT_BRIDGE_STATE;
  if (env.CLAUDE_BOT_BRIDGE_MAX_WAIT_MS) cfg.maxWaitMs = env.CLAUDE_BOT_BRIDGE_MAX_WAIT_MS;
  if (env.BOT_TIMEOUT_MS) cfg.timeoutMs = env.BOT_TIMEOUT_MS;

  if (env.CLAUDE_BOT_BRIDGE_BOTS) {
    let parsed;
    try {
      parsed = JSON.parse(env.CLAUDE_BOT_BRIDGE_BOTS);
    } catch (err) {
      throw new ConfigError(`CLAUDE_BOT_BRIDGE_BOTS is not valid JSON. ${err.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConfigError('CLAUDE_BOT_BRIDGE_BOTS must be a JSON object of bot id → settings.');
    }
    for (const [id, bot] of Object.entries(parsed)) {
      cfg.bots[id] = mergeBot(cfg.bots[id], normalizeBot(id, bot));
    }
  }

  const patch = envBotPatch(env);
  if (Object.keys(patch).length > 0) {
    const id = env.BOT_ID || (patch.url ? cfg.defaultBot || 'default' : cfg.defaultBot);
    if (!id || (!cfg.bots[id] && !patch.url)) {
      throw new ConfigError(
        'BOT_* settings were set, but there is no bot to attach them to. Set BOT_WEBHOOK_URL or BOT_ID of an existing bot.'
      );
    }
    const botId = id;
    cfg.bots[botId] = mergeBot(cfg.bots[botId], normalizeBot(botId, { ...patch, id: botId }));
  }

  if (env.CLAUDE_BOT_BRIDGE_DEFAULT_BOT) cfg.defaultBot = env.CLAUDE_BOT_BRIDGE_DEFAULT_BOT;
  else if (env.BOT_ID && cfg.bots[env.BOT_ID]) cfg.defaultBot = env.BOT_ID;

  if (env.BOT_INBOX_PORT) {
    cfg.inbox.enabled = true;
    cfg.inbox.port = env.BOT_INBOX_PORT;
  }
  if (env.BOT_INBOX_HOST) cfg.inbox.host = env.BOT_INBOX_HOST;
  if (env.BOT_INBOX_PATH) cfg.inbox.path = normalizeInboxPath(env.BOT_INBOX_PATH);
  if (env.BOT_INBOX_TOKEN) cfg.inbox.token = env.BOT_INBOX_TOKEN;
  if (env.BOT_INBOX_PUBLIC_URL) cfg.inbox.publicUrl = env.BOT_INBOX_PUBLIC_URL;
}

function envBotPatch(env) {
  const patch = {};
  if (env.BOT_WEBHOOK_URL) patch.url = env.BOT_WEBHOOK_URL;
  if (env.BOT_NAME) patch.name = env.BOT_NAME;
  if (env.BOT_WEBHOOK_KEY) patch.key = env.BOT_WEBHOOK_KEY;
  if (env.BOT_KEY_HEADER) patch.keyHeader = env.BOT_KEY_HEADER;
  if (Object.prototype.hasOwnProperty.call(env, 'BOT_KEY_PREFIX')) patch.keyPrefix = env.BOT_KEY_PREFIX;
  if (env.BOT_REPLY_URL) patch.replyUrl = env.BOT_REPLY_URL;
  return patch;
}

function finalizeBots(cfg, env) {
  const ids = Object.keys(cfg.bots);
  if (!cfg.defaultBot || !cfg.bots[cfg.defaultBot]) {
    if (cfg.defaultBot && !cfg.bots[cfg.defaultBot]) {
      throw new ConfigError(
        `defaultBot "${cfg.defaultBot}" does not match any configured bot. Configured: ${ids.join(', ') || '(none)'}.`
      );
    }
    cfg.defaultBot = ids[0] || null;
  }
  const globalTimeout = requirePositiveInt(cfg.timeoutMs, 'timeoutMs', 1000, 120000);
  cfg.timeoutMs = globalTimeout;
  cfg.maxWaitMs = requirePositiveInt(cfg.maxWaitMs, 'maxWaitMs', 1000, 600000);
  const forceTimeout = Boolean(env && env.BOT_TIMEOUT_MS);
  for (const bot of Object.values(cfg.bots)) {
    if (!bot.name) bot.name = bot.id;
    if (!bot.keyHeader) bot.keyHeader = 'Authorization';
    if (bot.keyPrefix === undefined) {
      bot.keyPrefix = bot.keyHeader.toLowerCase() === 'authorization' ? 'Bearer ' : '';
    }
    if (forceTimeout || bot.timeoutMs == null || bot.timeoutMs === '') bot.timeoutMs = globalTimeout;
    else bot.timeoutMs = requirePositiveInt(bot.timeoutMs, `Bot "${bot.id}" timeoutMs`, 1000, 120000);
  }
}

function validate(cfg) {
  const secrets = collectSecrets(cfg);
  if (typeof cfg.from !== 'string' || !cfg.from.trim() || cfg.from.length > 200 || /[\r\n]/.test(cfg.from)) {
    throw new ConfigError('Sender name "from" must be a single line up to 200 characters.');
  }
  for (const [id, bot] of Object.entries(cfg.bots)) {
    if (!BOT_ID_RE.test(id)) {
      throw new ConfigError(
        `Bot id "${clip(redact(String(id), secrets), 80)}" must be 1–64 characters: letters, numbers, and _ . : -`
      );
    }
    assertHttpUrl(bot.url, `Bot "${id}" url`, secrets, { required: true });
    if (bot.replyUrl) assertHttpUrl(bot.replyUrl, `Bot "${id}" replyUrl`, secrets, { required: false });
    if (bot.key != null && typeof bot.key !== 'string') {
      throw new ConfigError(`Bot "${id}" key must be a string.`);
    }
    if (bot.key && /[\r\n]/.test(bot.key)) {
      throw new ConfigError(`Bot "${id}" key must not contain newlines.`);
    }
    if (typeof bot.keyHeader !== 'string' || !HEADER_NAME_RE.test(bot.keyHeader)) {
      throw new ConfigError(`Bot "${id}" keyHeader is not a valid HTTP header name.`);
    }
    if (RESERVED_HEADERS.has(bot.keyHeader.toLowerCase())) {
      throw new ConfigError(`Bot "${id}" keyHeader cannot be ${bot.keyHeader}.`);
    }
    if (typeof bot.keyPrefix !== 'string' || /[\r\n]/.test(bot.keyPrefix) || bot.keyPrefix.length > 64) {
      throw new ConfigError(`Bot "${id}" keyPrefix must be a string of at most 64 characters without newlines.`);
    }
    if (typeof bot.name !== 'string' || !bot.name.trim() || bot.name.length > 100 || /[\r\n]/.test(bot.name)) {
      throw new ConfigError(`Bot "${id}" name must be a single line up to 100 characters.`);
    }
  }

  if (cfg.inbox.token && /[\r\n]/.test(cfg.inbox.token)) {
    throw new ConfigError('inbox.token must not contain newlines.');
  }
  if (cfg.inbox.publicUrl) assertHttpUrl(cfg.inbox.publicUrl, 'inbox.publicUrl', secrets, { required: false });
  if (cfg.inbox.enabled) {
    cfg.inbox.port = requirePositiveInt(cfg.inbox.port, 'inbox.port', 0, 65535);
    if (typeof cfg.inbox.host !== 'string' || !cfg.inbox.host.trim() || /[\r\n\s]/.test(cfg.inbox.host)) {
      throw new ConfigError('inbox.host must be a hostname or IP address without spaces.');
    }
    if (cfg.inbox.host.length > 255) throw new ConfigError('inbox.host is too long.');
    if (!/^\/[A-Za-z0-9._~/-]*$/.test(cfg.inbox.path)) {
      throw new ConfigError('inbox.path must start with "/" and contain only URL path characters.');
    }
  }

  Object.defineProperty(cfg, 'secrets', { value: secrets, enumerable: false });
}

function normalizeBot(id, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`Bot "${id}" must be a JSON object.`);
  }
  return {
    id,
    name: optionalTrimmed(raw.name),
    url: optionalTrimmed(raw.url),
    key: raw.key == null || raw.key === '' ? undefined : raw.key,
    keyHeader: optionalTrimmed(raw.keyHeader),
    keyPrefix: raw.keyPrefix === undefined || raw.keyPrefix === null ? undefined : String(raw.keyPrefix),
    replyUrl: optionalTrimmed(raw.replyUrl),
    timeoutMs: raw.timeoutMs == null || raw.timeoutMs === '' ? undefined : raw.timeoutMs,
  };
}

function mergeBot(base, patch) {
  const out = { ...(base || {}), id: patch.id };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function optionalTrimmed(value) {
  if (value == null) return undefined;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function interpolateTree(value, env, where) {
  if (typeof value === 'string') return interpolateString(value, env, where);
  if (Array.isArray(value)) {
    return value.map((item, index) => interpolateTree(item, env, `${where}[${index}]`));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const next = interpolateTree(child, env, `${where}.${key}`);
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  return value;
}

function interpolateString(value, env, where) {
  const whole = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (whole) {
    const name = whole[1];
    if (!hasEnv(env, name)) return undefined;
    return String(env[name]);
  }
  const missing = [];
  const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    if (!hasEnv(env, name)) {
      missing.push(name);
      return '';
    }
    return String(env[name]);
  });
  if (missing.length) {
    const names = [...new Set(missing)].join(', ');
    throw new ConfigError(`Config ${where} references unset or empty environment variable: ${names}.`);
  }
  return out;
}

function hasEnv(env, name) {
  if (!Object.prototype.hasOwnProperty.call(env, name) || env[name] == null) return false;
  return String(env[name]) !== '';
}

function asBool(value, label) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ConfigError(`${label} must be true or false.`);
}

function normalizeInboxPath(value) {
  let next = String(value || '').trim();
  if (!next.startsWith('/')) next = `/${next}`;
  if (next.length > 1 && next.endsWith('/')) next = next.slice(0, -1);
  return next;
}

function assertHttpUrl(value, label, secrets, { required }) {
  if (value == null || value === '') {
    if (required) throw new ConfigError(`${label} is required and must be an http or https URL.`);
    return;
  }
  if (typeof value !== 'string') throw new ConfigError(`${label} must be a string.`);
  if (value.length > 2000) throw new ConfigError(`${label} is too long.`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${label} is not a valid URL (${clip(redact(value, secrets), 120)}).`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${label} must use http or https, not "${url.protocol.replace(':', '')}".`);
  }
  if (url.username || url.password) {
    throw new ConfigError(`${label} must not include a username or password. Put the secret in "key" or BOT_WEBHOOK_KEY.`);
  }
}

function requirePositiveInt(value, label, min, max) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new ConfigError(`${label} must be an integer from ${min} to ${max}.`);
  }
  return number;
}

function collectSecrets(cfg) {
  const secrets = [];
  for (const bot of Object.values(cfg.bots || {})) {
    if (typeof bot.key === 'string') secrets.push(bot.key);
  }
  if (cfg.inbox && typeof cfg.inbox.token === 'string') secrets.push(cfg.inbox.token);
  return secrets;
}

function clip(text, max) {
  const oneLine = String(text || '').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max)}…`;
}

module.exports = {
  ConfigError,
  parseArgv,
  loadConfig,
};
