import { openDb, closeDb } from 'gtfs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SQL_DIR = path.resolve(__dirname, 'sql');

// Explicit dependency order so CREATE VIEW statements don’t fail.
// (We’ll run any extra .sql files alphabetically after these.)
const VIEW_ORDER = [
  'active_services_today.sql',        // base
  'trips_today.sql',                  // depends on active_services_today
  'trips_today_with_routes.sql',      // depends on trips_today
  'stop_time_updates_latest.sql',     // independent table -> view
  'stop_times_today.sql',             // depends on trips_today
  'stop_events_today.sql'             // depends on stop_times_today + stop_time_updates_latest
];

// Try common locations or specify GTFS_CONFIG=/path/to/config.json
const CONFIG_CANDIDATES = [
  process.env.GTFS_CONFIG && path.resolve(process.cwd(), process.env.GTFS_CONFIG),
  path.resolve(process.cwd(), 'config.json'),
  path.resolve(__dirname, '..', 'config.json')
].filter(Boolean);

async function loadConfig() {
  for (const p of CONFIG_CANDIDATES) {
    try {
      const txt = await readFile(p, 'utf8');
      const cfg = JSON.parse(txt);
      console.log(`[views] using config: ${p}`);
      return cfg;
    } catch {}
  }
  throw new Error('Could not find config.json; set GTFS_CONFIG=path/to/config.json');
}

// Make "DROP VIEW" tolerant for fresh DBs.
function tweakSqlForSqlite(sql) {
  // Add "IF EXISTS" to any DROP VIEW not already having it
  return sql.replace(/DROP\s+VIEW\s+(?!IF\s+EXISTS)/gi, 'DROP VIEW IF EXISTS ');
}

async function main() {
  const cfg = await loadConfig();
  const db = openDb(cfg); // better-sqlite3 instance from 'gtfs'

  try {
    db.pragma('journal_mode = WAL');
  } catch {}

  const files = await readdir(SQL_DIR);
  const sqlFiles = files.filter(f => f.toLowerCase().endsWith('.sql'));

  const ordered = [
    ...VIEW_ORDER.filter(f => sqlFiles.includes(f)),
    ...sqlFiles.filter(f => !VIEW_ORDER.includes(f)).sort()
  ];

  if (ordered.length === 0) {
    console.log('[views] no .sql files found in', SQL_DIR);
    await closeDb(db);
    return;
  }

  console.log('[views] applying files in order:');
  ordered.forEach(f => console.log('  •', f));

  for (const f of ordered) {
    const full = path.join(SQL_DIR, f);
    const raw = await readFile(full, 'utf8');
    const sql = tweakSqlForSqlite(raw);

    // Each file in its own transaction for clearer errors & atomicity
    db.exec('BEGIN;');
    try {
      db.exec(sql);
      db.exec('COMMIT;');
      console.log(`  ✓ ${f}`);
    } catch (err) {
      db.exec('ROLLBACK;');
      console.error(`  ✖ failed on ${f}: ${err.message}`);
      throw err;
    }
  }

  console.log('[views] all done ✅');
  await closeDb(db);
}

main().catch(err => {
  console.error('[views] error:', err);
  process.exit(1);
});