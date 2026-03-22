// src/services/cache.service.js
import Redis from 'ioredis';

let client = null;

function getClient() {
  if (!client) {
    client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
    });
    client.on('error', (err) => console.error('[Redis] ' + err.message));
  }
  return client;
}

export async function cacheGet(key) {
  try {
    const data = await getClient().get(key);
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key, value, ttlSec) {
  try {
    await getClient().set(key, JSON.stringify(value), 'EX', ttlSec);
  } catch {
    // silently fail — cache is best-effort
  }
}
