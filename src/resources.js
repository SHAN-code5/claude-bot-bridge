'use strict';

function createResources(store, config) {
  return {
    list() {
      const resources = [
        {
          uri: 'bridge://bots',
          name: 'bots',
          title: 'Configured bots',
          description: 'Bots this bridge can reach. Secrets are not included.',
          mimeType: 'text/plain',
        },
        {
          uri: 'bridge://threads',
          name: 'threads',
          title: 'Conversation threads',
          description: 'Threads stored in this process.',
          mimeType: 'text/plain',
        },
      ];
      for (const thread of store.threads()) {
        resources.push({
          uri: `bridge://thread/${encodeURIComponent(thread.threadId)}`,
          name: thread.threadId,
          title: `Thread ${thread.threadId}`,
          description: `${thread.count} messages`,
          mimeType: 'text/plain',
        });
      }
      return resources;
    },
    templates() {
      return [
        {
          uriTemplate: 'bridge://thread/{threadId}',
          name: 'thread',
          title: 'One conversation',
          description: 'Full transcript for a thread id, including messages the bridge sent.',
          mimeType: 'text/plain',
        },
      ];
    },
    read(uri) {
      if (uri === 'bridge://bots') return { uri, mimeType: 'text/plain', text: formatBots(config) };
      if (uri === 'bridge://threads') return { uri, mimeType: 'text/plain', text: formatThreads(store) };
      const match = /^bridge:\/\/thread\/([^?#]+)$/.exec(uri || '');
      if (match) {
        const threadId = decodeURIComponent(match[1]);
        return { uri, mimeType: 'text/plain', text: formatThread(store, threadId) };
      }
      return null;
    },
  };
}

function formatBots(config) {
  const lines = [`Default bot: ${config.defaultBot}`];
  for (const bot of Object.values(config.bots)) {
    lines.push('');
    lines.push(`${bot.id} — ${bot.name}`);
    lines.push(`webhook host: ${safeHost(bot.url)}`);
    lines.push(`auth: ${bot.key ? 'yes' : 'no'}`);
    lines.push(`signing: ${bot.signingSecret ? 'yes' : 'no'}`);
    lines.push(`reply poll: ${bot.replyUrl ? 'yes' : 'no'}`);
    lines.push(`reply sse: ${bot.sseUrl ? 'yes' : 'no'}`);
  }
  return lines.join('\n');
}

function formatThreads(store) {
  const threads = store.threads();
  if (threads.length === 0) return 'No threads yet.';
  return threads
    .map((thread) => `${thread.threadId}  messages=${thread.count}  last=${thread.lastAt}  bots=${thread.bots.join(',') || '-'}`)
    .join('\n');
}

function formatThread(store, threadId) {
  const visible = store.list().filter((item) => (item.threadId || 'unscoped') === threadId);
  if (visible.length === 0) return `No messages for thread ${threadId}.`;
  let text = visible
    .map((item) => `[${item.source}] ${item.at || item.receivedAt} bot=${item.bot || '-'}\n${item.text}`)
    .join('\n\n');
  const max = 100_000;
  if (text.length > max) text = `${text.slice(0, max)}\n… truncated`;
  return text;
}

function safeHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return 'invalid';
  }
}

module.exports = { createResources };
