'use strict';

/**
 * Replace known secrets with a placeholder. Secrets shorter than 4 characters
 * are ignored so a tiny value cannot punch holes in ordinary words.
 * Longer secrets are applied first so one secret that contains another is
 * removed whole.
 */
function redact(text, secrets) {
  let out = text == null ? '' : String(text);
  const list = [];
  const seen = new Set();
  for (const secret of secrets || []) {
    if (typeof secret !== 'string' || secret.length < 4 || seen.has(secret)) continue;
    seen.add(secret);
    list.push(secret);
  }
  list.sort((a, b) => b.length - a.length);
  for (const secret of list) {
    if (!out.includes(secret)) continue;
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

module.exports = { redact };
