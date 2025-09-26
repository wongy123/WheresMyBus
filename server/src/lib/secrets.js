// server/src/lib/secrets.js
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const REGION = process.env.AWS_REGION || 'ap-southeast-2';
const sm = new SecretsManagerClient({ region: REGION });

// simple cache so we don't re-fetch on every import
const cache = new Map(); // key -> { value, exp }
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function getSecretJson(secretId, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const now = Date.now();
  const hit = cache.get(secretId);
  if (hit && hit.exp > now) return hit.value;

  const resp = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  const raw = resp.SecretString ?? Buffer.from(resp.SecretBinary ?? '', 'base64').toString('utf8');
  if (!raw) throw new Error(`secret_empty: ${secretId}`);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`secret_not_json: ${secretId}`);
  }

  cache.set(secretId, { value: parsed, exp: now + ttlMs });
  return parsed;
}
