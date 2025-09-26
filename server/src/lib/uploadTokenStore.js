// src/lib/uploadTokenStore.js
import crypto from 'node:crypto';

const store = new Map(); // token -> { payload, exp }
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function createUploadToken(payload, ttlMs = DEFAULT_TTL_MS) {
  const token = crypto.randomBytes(32).toString('base64url');
  store.set(token, { payload, exp: Date.now() + ttlMs });
  return token;
}

export function consumeUploadToken(token) {
  const rec = store.get(token);
  if (!rec) return null;
  store.delete(token);
  if (Date.now() > rec.exp) return null;
  return rec.payload;
}

// prune occasionally
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store.entries()) {
    if (v.exp <= now) store.delete(k);
  }
}, 60_000).unref?.();
