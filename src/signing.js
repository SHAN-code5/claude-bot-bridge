'use strict';

const crypto = require('node:crypto');

const SKEW_MS = 5 * 60 * 1000;

function signHeaders(secret, rawBody, now = Date.now()) {
  const timestamp = String(now);
  const mac = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return {
    'X-Bridge-Timestamp': timestamp,
    'X-Bridge-Signature': `sha256=${mac}`,
  };
}

function verifySignature(secret, rawBody, timestamp, signature, now = Date.now()) {
  if (!secret) return true;
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > SKEW_MS) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${String(timestamp)}.${rawBody}`).digest('hex');
  const presented = String(signature).replace(/^sha256=/i, '').trim();
  return safeEqual(expected, presented);
}

function safeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue));
  const right = Buffer.from(String(rightValue));
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

module.exports = { signHeaders, verifySignature, SKEW_MS };
