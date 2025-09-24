// src/lib/publicBaseUrl.js
import { getParameter } from './ssm.js';

const PARAM_NAME = process.env.PUBLIC_BASE_URL_PARAM || '/n11941073/url';
let memo; // cache final URL for process lifetime

export async function resolvePublicBaseUrl() {
  if (memo) return memo;

  // Prefer env override if you have one (e.g., for local dev)
  const fromEnv = process.env.PUBLIC_BASE_URL;
  if (fromEnv) {
    memo = normalizeBaseUrl(fromEnv);
    return memo;
  }

  // Otherwise, read from SSM
  const raw = await getParameter(PARAM_NAME);
  // If SSM value is a bare host, add https://
  memo = normalizeBaseUrl(raw);
  return memo;
}

function normalizeBaseUrl(raw) {
  const trimmed = String(raw).trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, ''); // strip trailing slash
  return `https://${trimmed.replace(/\/+$/, '')}`;
}
