import { openDb, closeDb } from 'gtfs';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const defaultConfigPath = '../../config.json';

async function loadConfig(configPath = defaultConfigPath) {
  const full = path.join(__dirname, configPath);
  return JSON.parse(await readFile(full, 'utf8'));
}

/**
 * Opens the GTFS SQLite database, calls fn(db), then closes it.
 * Returns the value returned by fn.
 */
export async function withDb(fn, configPath = defaultConfigPath) {
  const config = await loadConfig(configPath);
  const db = openDb(config);
  try {
    return fn(db);
  } finally {
    await closeDb(db);
  }
}
