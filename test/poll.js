#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// ---------- Config ----------
const BASE = 'http://ec2-13-211-178-81.ap-southeast-2.compute.amazonaws.com:3000';
const WORKERS = Number(process.env.WORKERS || 100);
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 100);
// Set TIMEOUT_MS=0 to disable timeouts
const TIMEOUT_MS = process.env.TIMEOUT_MS === '0' ? 0 : Number(process.env.TIMEOUT_MS || 8000);
const ROUTE_DIRECTION = 1;

// Keep-alive agents reduce connection setup overhead/timeouts
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 256 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 256 });

globalThis.fetch = globalThis.fetch || require('node-fetch'); // Node <18 fallback

function loadList(filename) {
  const raw = fs.readFileSync(path.resolve(__dirname, filename), 'utf8');
  return raw.split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => s !== 'route_id' && s !== 'stop_id')
    .filter(s => /^[A-Za-z0-9-]+$/.test(s));
}
function pickRandom(arr) { return arr[(Math.random() * arr.length) | 0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithTimeout(url, shuttingDownRef) {
  const controller = new AbortController();
  let timer;
  try {
    if (TIMEOUT_MS > 0) {
      timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    }
    const isHttps = url.startsWith('https:');
    const res = await fetch(url, {
      signal: controller.signal,
      // attach keep-alive agent
      agent: isHttps ? httpsAgent : httpAgent,
    });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, text };
  } catch (err) {
    // If we’re shutting down, suppress noisy AbortError logs
    if (shuttingDownRef.value && (err?.name === 'AbortError' || String(err).includes('aborted'))) {
      return { ok: false, status: 0, abortedByShutdown: true };
    }
    // Real timeout/abort
    return { ok: false, status: 0, error: String(err), name: err?.name };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const ROUTE_IDS = loadList('route_ids.txt');
const STOP_IDS  = loadList('stop_ids.txt');
if (!ROUTE_IDS.length) { console.error('No route IDs in route_ids.txt'); process.exit(1); }
if (!STOP_IDS.length)  { console.error('No stop IDs in stop_ids.txt'); process.exit(1); }

const shuttingDown = { value: false };

async function tick(workerId) {
  const routeId = pickRandom(ROUTE_IDS);
  const stopId  = pickRandom(STOP_IDS);

  const routeURL = `${BASE}/route/${encodeURIComponent(routeId)}/upcoming?direction=${ROUTE_DIRECTION}`;
  const stopURL  = `${BASE}/stop/${encodeURIComponent(stopId)}/upcoming`;

  const ts = new Date().toISOString();

  const [routeRes, stopRes] = await Promise.all([
    fetchWithTimeout(routeURL, shuttingDown),
    fetchWithTimeout(stopURL, shuttingDown),
  ]);

  if (!routeRes.abortedByShutdown) {
    if (routeRes.ok) {
      console.log(`[${ts}][w${workerId}] GET ${routeURL} -> ${routeRes.status}`);
    } else {
      const why = routeRes.name === 'AbortError' ? 'timeout/abort' : (routeRes.error || 'error');
      console.warn(`[${ts}][w${workerId}] GET ${routeURL} -> ERROR 0 ${why}`);
    }
  }
  if (!stopRes.abortedByShutdown) {
    if (stopRes.ok) {
      console.log(`[${ts}][w${workerId}] GET ${stopURL}  -> ${stopRes.status}`);
    } else {
      const why = stopRes.name === 'AbortError' ? 'timeout/abort' : (stopRes.error || 'error');
      console.warn(`[${ts}][w${workerId}] GET ${stopURL}  -> ERROR 0 ${why}`);
    }
  }
}

async function worker(workerId, initialDelayMs = 0) {
  if (initialDelayMs) await sleep(initialDelayMs);
  while (!shuttingDown.value) {
    const start = Date.now();
    await tick(workerId);
    const elapsed = Date.now() - start;
    const wait = Math.max(0, INTERVAL_MS - elapsed);
    await sleep(wait);
  }
}

(async () => {
  console.log(`Starting ${WORKERS} workers; interval=${INTERVAL_MS}ms; timeout=${TIMEOUT_MS}ms (0=no-timeout)`);
  const stagger = Math.floor(INTERVAL_MS / Math.max(1, WORKERS));
  await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i + 1, i * stagger)));
})();

function stop() {
  if (shuttingDown.value) return;
  console.log('\nStopping workers (graceful)…');
  shuttingDown.value = true;
  // Give in-flight requests a moment to finish before process exit
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', stop);
process.o
