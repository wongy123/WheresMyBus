import express from 'express';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

// GTFS helpers
import { openDb, closeDb } from 'gtfs';
import { fetchGtfsRealtime } from './src/services/gtfsRealtime.service.js';

// Routers (make sure ./src/routes/index.js exports a default Express router)
import indexRouter from './src/routes/index.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const RT_UPDATE_INTERVAL_MS = Number(process.env.RT_UPDATE_INTERVAL_MS ?? 10000); // default 10s

const CONFIG_PATH = path.join(__dirname, './config.json');

async function loadConfig() {
  return JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
}

async function initDbPragmas() {
  const config = await loadConfig();
  const db = openDb(config);
  try {
    // Better read/write concurrency with SQLite
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 3000'); // ms
  } finally {
    await closeDb(db);
  }
}

// ---- Realtime updater (overlap guard) ----
let isUpdating = false;
let rtIntervalHandle = null;

async function runRealtimeUpdate() {
  if (isUpdating) return;
  isUpdating = true;
  const started = Date.now();
  try {
    await fetchGtfsRealtime(); // uses config.json internally (your service)
    const ms = Date.now() - started;
    console.log(`[RT] Updated in ${ms} ms`);
  } catch (err) {
    console.error('[RT] Update failed:', err?.message || err);
  } finally {
    isUpdating = false;
  }
}

function startRealtimeLoop() {
  // warm cache immediately, then every N seconds
  runRealtimeUpdate();
  rtIntervalHandle = setInterval(runRealtimeUpdate, RT_UPDATE_INTERVAL_MS);
}

function stopRealtimeLoop() {
  if (rtIntervalHandle) clearInterval(rtIntervalHandle);
}

// ---- Express setup ----
app.use(express.json());

app.get('/', (_req, res) => {
  res.send('Welcome to the WheresMyBus server!');
});

app.use('/api', indexRouter);

// ---- Start server & bootstrap background tasks ----
const server = app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);

  try {
    await initDbPragmas();
  } catch (e) {
    console.warn('Failed to set SQLite PRAGMAs (continuing):', e?.message || e);
  }

  startRealtimeLoop();
});

// ---- Graceful shutdown ----
async function shutdown() {
  console.log('Shutting down...');
  stopRealtimeLoop();

  // Wait (briefly) for an in-flight update to finish
  const waitUntil = Date.now() + 5000;
  while (isUpdating && Date.now() < waitUntil) {
    await new Promise(r => setTimeout(r, 100));
  }

  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });

  // Force-exit if something hangs
  setTimeout(() => process.exit(0), 7000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
