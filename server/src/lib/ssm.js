// src/lib/ssm.js
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const REGION = process.env.AWS_REGION || 'ap-southeast-2';
const ssm = new SSMClient({ region: REGION });

// simple in-memory cache
const cache = new Map(); // name -> { value, exp }
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 min

export async function getParameter(name, { withDecryption = false, ttlMs = DEFAULT_TTL_MS } = {}) {
  const now = Date.now();
  const hit = cache.get(name);
  if (hit && hit.exp > now) return hit.value;

  const resp = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: withDecryption }));
  const value = resp?.Parameter?.Value;
  if (!value) throw new Error(`ssm_parameter_not_found: ${name}`);

  cache.set(name, { value, exp: now + ttlMs });
  return value;
}
