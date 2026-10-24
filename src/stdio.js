'use strict';

const MAX_BUFFER = 2_000_000;

/**
 * Newline-delimited JSON, which is what MCP stdio uses.
 * Messages are handled one at a time so a wait_for_reply cannot overlap a send.
 */
function createLineReader(onMessage, onOverflow) {
  let buf = '';
  let chain = Promise.resolve();

  return {
    push(chunk) {
      buf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (buf.length > MAX_BUFFER) {
        buf = '';
        chain = chain.then(() => (onOverflow ? onOverflow() : undefined));
        return chain;
      }
      const lines = [];
      let splitAt = buf.indexOf('\n');
      while (splitAt >= 0) {
        let line = buf.slice(0, splitAt);
        buf = buf.slice(splitAt + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.trim()) lines.push(line.trim());
        splitAt = buf.indexOf('\n');
      }
      for (const line of lines) {
        chain = chain.catch(() => {}).then(() => onMessage(line));
      }
      return chain;
    },
    get idle() {
      return chain;
    },
  };
}

module.exports = { createLineReader, MAX_BUFFER };
