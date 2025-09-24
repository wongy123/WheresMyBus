// src/lib/handoffStore.js
import crypto from 'node:crypto';

const store = new Map(); // key -> { payload, exp }
const DEFAULT_TTL_MS = 120_000; // 2 minutes

export function createHandoff(payload, ttlMs = DEFAULT_TTL_MS) {
  const code = crypto.randomBytes(32).toString('base64url');
  const exp = Date.now() + ttlMs;
  store.set(code, { payload, exp });
  return code;
}

export function consumeHandoff(code) {
  const rec = store.get(code);
  if (!rec) return null;
  store.delete(code);
  if (Date.now() > rec.exp) return null;
  return rec.payload;
}

// optional cleanup (best-effort)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store.entries()) {
    if (v.exp <= now) store.delete(k);
  }
}, 60_000).unref?.();
