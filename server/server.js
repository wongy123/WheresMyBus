// server.js
import express from 'express';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { initSchema, pool } from './src/models/db.js';
import cors from 'cors';
import { cache } from './src/lib/cache.js';

// GTFS helpers (only for PRAGMAs/opening read-only DB as needed)
import { openDb } from 'gtfs';

// NEW: use the cache-populating realtime loop
import { startGtfsRealtimeLoop, stopGtfsRealtimeLoop } from './src/services/gtfsRealtime.service.js';

// Routers
import indexRouter from './src/routes/index.js';

dotenv.config();
await initSchema();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

// Never time out any request/response (useful for slow CPUs / load tests)
app.use((req, res, next) => {
  if (typeof req.setTimeout === 'function') req.setTimeout(0);
  if (typeof res.setTimeout === 'function') res.setTimeout(0);
  next();
});

app.set('trust proxy', true);

const CONFIG_PATH = path.join(__dirname, './config.json');

async function loadConfig() {
  return JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
}

async function initDbPragmas() {
  try {
    const config = await loadConfig();
    const db = openDb(config); // opens (or returns) the global connection
    // these are harmless even if SQLite file is read-only
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 3000');
    // DO NOT close here — the GTFS package uses a global connection
  } catch (e) {
    console.warn('Failed to set SQLite PRAGMAs (continuing):', e?.message || e);
  }
}


// ---- Express setup ----
app.use(express.json());

app.get('/', (_req, res) => {
  res.send('Welcome to the WheresMyBus server!');
});

app.get('/_debug/rt/:tripId', async (req, res) => {
  const key = `rt:trip:${req.params.tripId}`;
  const val = await cache.get(key);
  res.json({ key, found: !!val, val });
});

app.get('/_debug/rt-heartbeat', async (_req, res) => {
  const hb = await cache.get('rt:feed:ts');
  res.json({ hb });
});

app.use('/api', indexRouter);

// Error → JSON (includes multer file type/size errors)
app.use((err, _req, res, _next) => {
  console.error(err);
  if (err?.message === 'unsupported_file_type') {
    return res.status(400).json({ error: 'unsupported_file_type' });
  }
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'file_too_large' });
  }
  return res.status(500).json({ error: 'server_error' });
});

// ---- Start server & bootstrap background tasks ----
const server = app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);

  await initDbPragmas();

  const cfg = await loadConfig();
  openDb(cfg);

  // NEW: start the cache-populating realtime loop (no DB writes)
  startGtfsRealtimeLoop();
});

// Fully disable Node http timeouts (headers + entire request + socket inactivity)
server.setTimeout(0);
server.requestTimeout = 0;
server.headersTimeout = 0;

// ---- Graceful shutdown ----
async function shutdown() {
  console.log('Shutting down...');

  // NEW: stop the cache-populating loop
  try { stopGtfsRealtimeLoop(); } catch {}

  server.close(async () => {
    console.log('HTTP server closed.');
    try {
      await pool.end();
      console.log('Postgres pool closed.');
    } catch {}
    process.exit(0);
  });

  // Force-exit if something hangs
  setTimeout(() => process.exit(0), 7000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
