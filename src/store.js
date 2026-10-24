'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { redact } = require('./redact');

const MAX_REPLIES = 1000;

class ReplyStore {
  constructor(options = {}) {
    this.file = options.file || null;
    this.secrets = options.secrets || [];
    this.max = options.max || MAX_REPLIES;
    this.items = [];
    this.seen = new Set();
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
    while (this.items.length > this.max) {
      const dropped = this.items.shift();
      this.seen.delete(dropped.id);
    }
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

  save() {
    if (!this.file) return;
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ replies: this.items }, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

function matches(item, filter) {
  if (filter.bot && item.bot && item.bot !== filter.bot) return false;
  if (filter.threadId && item.threadId && item.threadId !== filter.threadId) return false;
  if (filter.exclude && filter.exclude.has(item.id)) return false;
  if (filter.sinceMs != null) {
    const stamp = Date.parse(item.at || item.receivedAt);
    if (Number.isFinite(stamp) && stamp < filter.sinceMs) return false;
  }
  return true;
}

module.exports = { ReplyStore, matches, MAX_REPLIES };
