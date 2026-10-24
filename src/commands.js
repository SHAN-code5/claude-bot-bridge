'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadConfig } = require('./config');
const { postWebhook } = require('./webhook');
const { zipStore } = require('./zip');

const pkg = require('../package.json');

function claudeConfigPath(platform, homedir, env) {
  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  if (platform === 'win32') {
    const base = (env && env.APPDATA) || path.join(homedir, 'AppData', 'Roaming');
    return path.join(base, 'Claude', 'claude_desktop_config.json');
  }
  const base = (env && env.XDG_CONFIG_HOME) || path.join(homedir, '.config');
  return path.join(base, 'Claude', 'claude_desktop_config.json');
}

function serverEntry() {
  return path.resolve(__dirname, '..', 'bin', 'claude-bot-bridge.js');
}

function buildDesktopEntry({ url, key, name, replyUrl, sseUrl, from }) {
  const env = {
    BOT_WEBHOOK_URL: url,
    BOT_NAME: name || 'Assistant',
    BOT_FROM: from || 'Claude Desktop',
  };
  if (key) env.BOT_WEBHOOK_KEY = key;
  if (replyUrl) env.BOT_REPLY_URL = replyUrl;
  if (sseUrl) env.BOT_REPLY_SSE_URL = sseUrl;
  return {
    command: 'node',
    args: [serverEntry()],
    env,
  };
}

function initCommand(options) {
  const argv = options.argv || [];
  const flags = parseFlags(argv);
  const platform = options.platform || process.platform;
  const homedir = options.homedir || os.homedir();
  const env = options.env || {};
  const target = flags.config || flags['config-path'] || claudeConfigPath(platform, homedir, env);
  const url = flags.url || env.BOT_WEBHOOK_URL;
  if (!url) {
    throw new Error('Pass --url <webhook>. Example: claude-bot-bridge init --url https://example.com/webhook --key secret');
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('Webhook URL is not valid. Use an http or https URL.');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('Webhook URL must use http or https.');
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error('Put the secret in --key or BOT_WEBHOOK_KEY, not in the URL.');
  }
  const entry = buildDesktopEntry({
    url,
    key: flags.key || env.BOT_WEBHOOK_KEY || '',
    name: flags.name || 'Assistant',
    replyUrl: flags['reply-url'] || '',
    sseUrl: flags['sse-url'] || '',
    from: flags.from || 'Claude Desktop',
  });
  if (!entry.env.BOT_WEBHOOK_KEY) delete entry.env.BOT_WEBHOOK_KEY;
  if (!entry.env.BOT_REPLY_URL) delete entry.env.BOT_REPLY_URL;
  if (!entry.env.BOT_REPLY_SSE_URL) delete entry.env.BOT_REPLY_SSE_URL;

  let current = {};
  if (fs.existsSync(target)) {
    const raw = fs.readFileSync(target, 'utf8');
    try {
      current = JSON.parse(raw);
    } catch {
      throw new Error(`Claude config is not valid JSON: ${target}. Fix it before init merges the bridge in.`);
    }
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      throw new Error(`Claude config must be a JSON object: ${target}`);
    }
  }
  if (!current.mcpServers || typeof current.mcpServers !== 'object') current.mcpServers = {};
  current.mcpServers['claude-bot-bridge'] = entry;
  if (flags.print || flags['dry-run']) {
    return { path: target, config: current, wrote: false };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  return { path: target, config: current, wrote: true };
}

async function doctorCommand(options) {
  const env = options.env || process.env;
  const flags = parseFlags(options.argv || []);
  const config = options.config || loadConfig({ configPath: flags.config, env, cwd: options.cwd || process.cwd() });
  const fetchImpl = options.fetchImpl || fetch;
  const checks = [];
  checks.push({ name: 'node', ok: true, detail: process.version });
  for (const bot of Object.values(config.bots)) {
    const probe = { ...bot, timeoutMs: Math.min(bot.timeoutMs || 8000, 8000) };
    try {
      const response = await postWebhook(
        probe,
        {
          from: 'claude-bot-bridge doctor',
          message: 'ping',
          context: '',
          doctor: true,
          sentAt: new Date().toISOString(),
          threadId: 'doctor',
          messageId: 'doctor',
          bot: bot.id,
        },
        { fetchImpl, secrets: config.secrets }
      );
      checks.push({ name: `webhook ${bot.id}`, ok: true, detail: `HTTP ${response.status}` });
    } catch (err) {
      checks.push({ name: `webhook ${bot.id}`, ok: false, detail: err.message });
    }
    if (bot.replyUrl) {
      try {
        const response = await fetchImpl(bot.replyUrl, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(probe.timeoutMs) });
        checks.push({
          name: `reply ${bot.id}`,
          ok: response.status >= 200 && response.status < 400,
          detail: `HTTP ${response.status}`,
        });
      } catch (err) {
        checks.push({ name: `reply ${bot.id}`, ok: false, detail: err.message });
      }
    }
    if (bot.sseUrl) {
      checks.push({ name: `sse ${bot.id}`, ok: true, detail: bot.sseUrl });
    }
  }
  if (config.inbox.enabled) {
    checks.push({
      name: 'inbox',
      ok: true,
      detail: `${config.inbox.host}:${config.inbox.port}${config.inbox.path} token=${config.inbox.token ? 'yes' : 'no'}`,
    });
  }
  const ok = checks.every((check) => check.ok);
  return { ok, checks };
}

function formatDoctor(report) {
  const lines = report.checks.map((check) => `${check.ok ? 'ok' : 'FAIL'}  ${check.name}: ${check.detail}`);
  lines.push(report.ok ? 'doctor: ready' : 'doctor: failed');
  return lines.join('\n');
}

function packCommand(options = {}) {
  const root = options.root || path.resolve(__dirname, '..');
  const out = options.out || path.join(root, 'claude-bot-bridge.mcpb');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'mcpb', 'manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  const files = [{ name: 'manifest.json', data: `${JSON.stringify(manifest, null, 2)}\n` }];
  for (const relative of walk(root, ['bin', 'src'])) {
    files.push({ name: relative, data: fs.readFileSync(path.join(root, relative)) });
  }
  files.push({ name: 'package.json', data: fs.readFileSync(path.join(root, 'package.json')) });
  files.push({ name: 'LICENSE', data: fs.readFileSync(path.join(root, 'LICENSE')) });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, zipStore(files));
  return { out, entries: files.map((file) => file.name) };
}

function startTunnel({ port, spawnImpl, timeoutMs = 20000 }) {
  const spawnFn = spawnImpl || spawn;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(tunnelError(err));
      return;
    }
    let text = '';
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Timed out waiting for a tunnel URL from cloudflared.')), timeoutMs);
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        if (child) child.kill();
        reject(err);
        return;
      }
      resolve(value);
    };
    const onData = (buf) => {
      text += buf.toString();
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (!match) return;
      finish(null, {
        url: match[0],
        close() {
          child.kill();
        },
      });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => finish(tunnelError(err)));
    child.on('exit', (code) => {
      if (!settled) finish(new Error(`cloudflared exited (${code}) before printing a URL.`));
    });
  });
}

function tunnelError(err) {
  if (err && err.code === 'ENOENT') {
    return new Error(
      'cloudflared is not installed. See https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/ and run claude-bot-bridge tunnel again.'
    );
  }
  return err;
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const body = token.slice(2);
    if (body.includes('=')) {
      const split = body.indexOf('=');
      out[body.slice(0, split)] = body.slice(split + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) out[body] = true;
    else {
      out[body] = next;
      i += 1;
    }
  }
  return out;
}

function walk(root, directories) {
  const found = [];
  for (const directory of directories) {
    const absolute = path.join(root, directory);
    if (!fs.existsSync(absolute)) continue;
    visit(absolute, directory, found);
  }
  return found;
}

function visit(absolute, relative, found) {
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const nextRelative = `${relative}/${entry.name}`;
    const nextAbsolute = path.join(absolute, entry.name);
    if (entry.isDirectory()) visit(nextAbsolute, nextRelative, found);
    else if (entry.isFile() && entry.name.endsWith('.js')) found.push(nextRelative);
  }
}

module.exports = {
  claudeConfigPath,
  buildDesktopEntry,
  initCommand,
  doctorCommand,
  formatDoctor,
  packCommand,
  startTunnel,
  parseFlags,
};
