'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { redact } = require('./redact');

const MAX_REPLIES = 1000;
const SAVE_DELAY_MS = 50;

class ReplyStore {
  constructor(options = {}) {
    this.file = options.file || null;
    this.secrets = options.secrets || [];
    this.max = options.max || MAX_REPLIES;
    this.items = [];
    this.seen = new Set();
    this.saveTimer = null;
    this.onError = options.onError || ((err) => console.error(`claude-bot-bridge: ${err.message}`));
    if (this.file) this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      throw new Error(`Could not read state file ${this.file}: ${err.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`State file is not valid JSON (${this.file}).`);
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.replies)) {
      throw new Error(`State file ${this.file} must be a JSON object with a "replies" array.`);
    }
    for (const reply of parsed.replies) {
      if (!reply || typeof reply.id !== 'string' || typeof reply.text !== 'string') continue;
      if (this.seen.has(reply.id) || !reply.text.trim()) continue;
      this.seen.add(reply.id);
      this.items.push({
        id: reply.id,
        bot: reply.bot || null,
        threadId: reply.threadId || null,
        messageId: reply.messageId || null,
        text: redact(reply.text, this.secrets),
        source: reply.source || 'unknown',
        at: reply.at || null,
        receivedAt: reply.receivedAt || new Date().toISOString(),
        delivered: Boolean(reply.delivered),
      });
    }
    this.trim();
  }

  trim() {
    while (this.items.length > this.max) {
      const dropped = this.items.shift();
      this.seen.delete(dropped.id);
    }
  }

  add(reply) {
    if (!reply || typeof reply.text !== 'string' || !reply.text.trim()) return null;
    if (!reply.id || this.seen.has(reply.id)) return null;
    const stored = {
      id: reply.id,
      bot: reply.bot || null,
      threadId: reply.threadId || null,
      messageId: reply.messageId || null,
      text: redact(reply.text.trim(), this.secrets),
      source: reply.source || 'unknown',
      at: reply.at || null,
      receivedAt: reply.receivedAt || new Date().toISOString(),
      delivered: Boolean(reply.delivered),
    };
    if (!stored.text.trim()) return null;
    this.seen.add(stored.id);
    this.items.push(stored);
    this.trim();
    this.save();
    return stored;
  }

  markDelivered(id) {
    const found = this.items.find((item) => item.id === id);
    if (found) {
      found.delivered = true;
      this.save();
    }
    return found || null;
  }

  list(filter = {}) {
    return this.items.filter((item) => matches(item, filter));
  }

  nextUndelivered(filter = {}) {
    return this.items.find((item) => !item.delivered && matches(item, filter)) || null;
  }

  ids() {
    return this.items.map((item) => item.id);
  }

  threads() {
    const map = new Map();
    for (const item of this.items) {
      const threadId = item.threadId || 'unscoped';
      if (!map.has(threadId)) {
        map.set(threadId, { threadId, count: 0, lastAt: item.receivedAt, bots: new Set() });
      }
      const row = map.get(threadId);
      row.count += 1;
      row.lastAt = item.receivedAt || row.lastAt;
      if (item.bot) row.bots.add(item.bot);
    }
    return [...map.values()].map((row) => ({ ...row, bots: [...row.bots] }));
  }

  /**
   * Schedule a write. A burst of replies or deliveries becomes one rewrite of
   * the file instead of one per change. close() and flush() write at once.
   */
  save() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      // A failed background write (disk full, permissions) must not crash the
      // server. The replies stay in memory and the next change retries.
      try {
        this.flush();
      } catch (err) {
        this.onError(new Error(`could not write state file ${this.file}: ${err.message}`));
      }
    }, SAVE_DELAY_MS);
  }

  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.file) return;
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ replies: this.items }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      // Some platforms cannot chmod. The file still holds the replies.
    }
  }
}

function matches(item, filter) {
  if (filter.bot && item.bot && item.bot !== filter.bot) return false;
  if (filter.threadId && item.threadId && item.threadId !== filter.threadId) return false;
  if (filter.exclude && filter.exclude.has(item.id)) return false;
  if (filter.excludeSources && filter.excludeSources.includes(item.source)) return false;
  if (filter.sinceMs != null) {
    const stamp = Date.parse(item.at || item.receivedAt);
    if (Number.isFinite(stamp) && stamp < filter.sinceMs) return false;
  }
  return true;
}

module.exports = { ReplyStore, matches, MAX_REPLIES };
