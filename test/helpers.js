'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadConfig } = require('../src/config');

const bin = path.join(__dirname, '..', 'bin', 'claude-bot-bridge.js');
const root = path.join(__dirname, '..');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bot-bridge-'));
}

function load(env, cwd = tempDir()) {
  return loadConfig({ env, cwd });
}

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done, fail) => {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, body, headers = {}) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(raw),
    ...headers,
  });
  res.end(raw);
}

function spawnBridge(env = {}, args = []) {
  const child = spawn(process.execPath, [bin, ...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || os.homedir(),
      TMPDIR: process.env.TMPDIR || os.tmpdir(),
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const waiters = new Map();
  child.unexpected = [];
  child.stderrText = () => stderr;

  child.stdout.on('data', (buf) => {
    stdout += buf.toString('utf8');
    let splitAt = stdout.indexOf('\n');
    while (splitAt >= 0) {
      const line = stdout.slice(0, splitAt).trim();
      stdout = stdout.slice(splitAt + 1);
      splitAt = stdout.indexOf('\n');
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        child.unexpected.push(line);
        continue;
      }
      if (msg.id != null && waiters.has(String(msg.id))) {
        const waiter = waiters.get(String(msg.id));
        clearTimeout(waiter.timer);
        waiters.delete(String(msg.id));
        waiter.resolve(msg);
      } else {
        child.unexpected.push(msg);
      }
    }
  });
  child.stderr.on('data', (buf) => {
    stderr += buf.toString('utf8');
  });
  child.stdin.on('error', () => {});

  child.request = (method, params, id = Math.floor(Math.random() * 1e9)) => {
    const key = String(id);
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(key);
        reject(new Error(`timed out waiting for ${method} id=${id}\nstderr:\n${stderr}\nremaining stdout:\n${stdout}`));
      }, 8000);
      waiters.set(key, { resolve, timer });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  };

  child.notify = (method, params) => {
    const payload = { jsonrpc: '2.0', method };
    if (params !== undefined) payload.params = params;
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  child.stop = () =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stderr });
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 3000);
      child.once('close', (code) => finish(code));
      if (child.exitCode != null || child.signalCode) child.stdin.end();
      else child.stdin.end();
    });

  return child;
}

module.exports = {
  bin,
  root,
  tempDir,
  load,
  listen,
  readBody,
  json,
  spawnBridge,
};
