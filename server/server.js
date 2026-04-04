// server.js
import express from 'express';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import cors from 'cors';
import { cacheGet } from './src/services/cache.service.js';

import { openDb } from 'gtfs';

import { startGtfsRealtimeLoop, stopGtfsRealtimeLoop, getLatestVehiclePositions, getLatestTripUpdateCount } from './src/services/gtfsRealtime.service.js';

import indexRouter from './src/routes/index.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

app.use((req, _res, next) => {
  if (typeof req.setTimeout === 'function') req.setTimeout(0);
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
    const db = openDb(config);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 3000');
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
  const val = await cacheGet(key);
  res.json({ key, found: !!val, val });
});

app.get('/_debug/rt-heartbeat', async (_req, res) => {
  const hb = await cacheGet('rt:feed:ts');
  res.json({ hb });
});

app.get('/api/_debug/stats', async (_req, res) => {
  try {
    const vposMap = getLatestVehiclePositions();
    const now = Date.now();
    const feedTs = await cacheGet('rt:feed:ts');
    const lastUpdate = feedTs ? feedTs.ts : null;
    const secondsAgo = lastUpdate ? Math.round((now - lastUpdate) / 1000) : null;

    res.json({
      liveTrips: getLatestTripUpdateCount(),
      liveVehicles: vposMap.size,
      lastUpdateSecondsAgo: secondsAgo,
      status: secondsAgo !== null && secondsAgo < 60 ? 'live' : 'stale',
    });
  } catch (e) {
    console.error('stats error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.use('/api', indexRouter);
app.use('/wheresmybus-api/api', indexRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  return res.status(500).json({ error: 'server_error' });
});

// ---- Start server & bootstrap background tasks ----
const server = app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);

  await initDbPragmas();

  startGtfsRealtimeLoop();
});

server.setTimeout(0);
server.requestTimeout = 0;
server.headersTimeout = 0;

// ---- Graceful shutdown ----
async function shutdown() {
  console.log('Shutting down...');

  try { stopGtfsRealtimeLoop(); } catch {}

  server.close(async () => {
    console.log('HTTP server closed.');
    process.exit(0);
  });

  setTimeout(() => process.exit(0), 7000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
