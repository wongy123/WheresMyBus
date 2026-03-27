import { openDb } from 'gtfs';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const defaultConfigPath = '../../config.json';

async function loadConfig(configPath = defaultConfigPath) {
  const full = path.join(__dirname, configPath);
  return JSON.parse(await readFile(full, 'utf8'));
}

// Singleton DB connections keyed by configPath — opened once, reused forever.
// Eliminates per-request config read + SQLite open/close overhead.
const dbCache = new Map();

async function getDb(configPath = defaultConfigPath) {
  if (dbCache.has(configPath)) return dbCache.get(configPath);
  const config = await loadConfig(configPath);
  const db = openDb(config);
  dbCache.set(configPath, db);
  return db;
}

/**
 * Returns the result of fn(db) using a persistent SQLite connection.
 */
export async function withDb(fn, configPath = defaultConfigPath) {
  const db = await getDb(configPath);
  return fn(db);
}
