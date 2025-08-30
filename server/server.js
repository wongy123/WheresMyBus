import express from 'express';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { initSchema, pool } from './src/models/db.js';
import cors from 'cors';

// GTFS helpers
import { openDb, closeDb } from 'gtfs';
import { fetchGtfsRealtime } from './src/services/gtfsRealtime.service.js';

// Routers (make sure ./src/routes/index.js exports a default Express router)
import indexRouter from './src/routes/index.js';

dotenv.config();
await initSchema();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;
const RT_UPDATE_INTERVAL_MS = Number(process.env.RT_UPDATE_INTERVAL_MS ?? 10000); // default 10s
const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');

// Never time out any request/response (useful for slow CPUs / load tests)
app.use((req, res, next) => {
  // Disable timeouts on the underlying sockets
  if (typeof req.setTimeout === 'function') req.setTimeout(0);
  if (typeof res.setTimeout === 'function') res.setTimeout(0);
  next();
});

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
  } catch (e) {
    console.warn('Failed to set SQLite PRAGMAs (continuing):', e?.message || e);
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

// make sure uploads/ exists (and a stops/ subdir for your current use)
await mkdir(path.join(UPLOADS_DIR, 'stops'), { recursive: true });
// serve static files (so /static/stops/.. works)
app.use('/static', express.static(UPLOADS_DIR));

app.get('/', (_req, res) => {
  res.send('Welcome to the WheresMyBus server!');
});

app.use('/api', indexRouter);

// Error → JSON (includes multer file type/size errors)
app.use((err, _req, res, _next) => {
  console.error(err);
  if (err?.message === 'unsupported_file_type') {
    return res.status(400).json({ error: 'unsupported_file_type' });
  }
  // Multer size limit
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'file_too_large' });
  }
  return res.status(500).json({ error: 'server_error' });
});


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

// Fully disable Node http timeouts (headers + entire request + socket inactivity)
server.setTimeout(0);        // socket inactivity timeout (legacy)
server.requestTimeout = 0;   // time to receive entire request (default ~5m)
server.headersTimeout = 0;   // time to receive headers (default ~60s)

// ---- Graceful shutdown ----
async function shutdown() {
  console.log('Shutting down...');
  stopRealtimeLoop();

  // Wait (briefly) for an in-flight update to finish
  const waitUntil = Date.now() + 5000;
  while (isUpdating && Date.now() < waitUntil) {
    await new Promise(r => setTimeout(r, 100));
  }

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
