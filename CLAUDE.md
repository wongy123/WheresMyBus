# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

**Where's My Bus** is a real-time Brisbane public transit tracker for South East Queensland. It displays live arrivals, delays, and vehicle positions for buses, trains, ferries, and the G:link tram using Translink's GTFS (static) and GTFS-RT (real-time) feeds.

## Commands

### Local Development

**API server** (Node.js/Express, port 3000):
```bash
cd server
npm install
npm run import        # One-time: download and import GTFS static data into SQLite (~773 MB)
npm run buildviews    # One-time: create materialized SQLite views
npm start             # Start API server (nodemon)
```

**Web client** (Python/Flask, port 5000):
```bash
cd client
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

**Docker Compose (all-in-one)**:
```bash
docker compose up -d --build
```

### Other API Scripts
```bash
npm run fetchrealtime   # Manual trigger of GTFS-RT polling
npm run buildviews      # Rebuild SQLite materialized views
```

### E2E Tests
E2E tests use Playwright and live in `client/tests/`. Config is in `client/playwright.config.js`.

## Architecture Overview

### Data Flow

```
Translink GTFS Static Feed → [npm run import] → SQLite (~773 MB)
                                                    ↓
                                          [npm run buildviews]
                                          Materialized SQL views
                                                    ↓
Translink GTFS-RT Feeds → Background polling loop (3s) → Redis cache
                                                    ↓
                                          API queries merge both sources
                                                    ↓
                                          Flask renders Jinja2 templates
                                          Browser JS makes direct fetch() for live updates
```

### Components

**API server** (`server/`): Node.js/Express (ESM modules), handles all data access.
- `src/controllers/` — Route handlers for stops, routes, vehicles, geocode
- `src/routes/` — Express route definitions
- `src/services/` — Business logic: GTFS import, real-time polling, Redis caching, SQL queries
- `src/utils/` — Helpers: DB queries, pagination, param parsing
- `sqlite/db.js` — Builds materialized views; `sqlite/sql/` — SQL view definitions
- `sqlite/translink.db` — Generated SQLite database (~773 MB, not in git)

**Web client** (`client/`): Python/Flask with server-side Jinja2 rendering.
- `app.py` — Flask app factory
- `api.py` — HTTP client for Flask→API calls
- `route.py`, `stop.py`, `timetable.py`, `map.py` — Flask blueprints
- `helpers.py` — Jinja2 filters and template utilities
- `templates/` — Jinja2 templates; HTMX used for progressive enhancement
- `static/timetable.js` — Countdown logic and time formatting
- `static/transit.js` — Route colors, Leaflet icons, vehicle markers
- `static/diagmap.js` — Stop modal map logic

**Redis**: Short-TTL cache for real-time data.
- `rt:trip:<tripId>` — 300s TTL (trip updates/delays)
- `rt:vpos:<tripId>` — 60s TTL (vehicle positions)
- `rt:feed:ts` — 60s TTL (feed freshness timestamp)

### Real-Time Enrichment

After SQL returns a row, `applyRealtimeToRow()` checks Redis for matching trip/vehicle keys and merges delay offsets and vehicle position data. Falls back to `stop_time_updates` table on Redis miss. Bogus delays (stop_sequence 1 stale positions) are filtered.

### API Endpoints

All under `/api/` (also `/wheresmybus-api/api/` for subpath deployments):

| Endpoint | Purpose |
|----------|---------|
| `/stops/search?q=` | Search stops by name/code |
| `/stops/<stop_id>` | Stop details |
| `/stops/<stop_id>/timetable` | Upcoming services at a stop |
| `/stops/<stop_id>/platforms` | Child platforms (stations) |
| `/routes/<route_id>` | Route details |
| `/routes/<route_id>/upcoming?direction=` | Upcoming services on a route |
| `/vehicles/<trip_id>` | Real-time vehicle position |
| `/geocode?lat=&lng=` | Reverse geocode to nearby stops |
| `/_debug/rt/<tripId>` | Inspect real-time data for a trip |
| `/_debug/rt-heartbeat` | Check last GTFS-RT feed timestamp |

## Configuration

**`server/.env`**:
```
REDIS_URL=redis://localhost:6379
GTFS_RT_TRIP_UPDATES_URL=https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates
GTFS_RT_VEHICLE_POSITIONS_URL=https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions
GTFS_RT_TIMEOUT_MS=4000
PORT=3000
```

**`client/.env`**:
```
API_BASE_URL=http://localhost:3000/api           # Server-side (Flask → API)
API_BASE_URL_PUBLIC=http://localhost:3000/api    # Browser-side (JS fetch)
FLASK_SECRET_KEY=change-me-in-production
BASE_PATH=                                        # e.g. "/wheresmybus" or ""
```

## Key Documentation Files

- `REALTIME.md` — GTFS-RT ingestion, Redis keys, TTLs, enrichment flow
- `FRONTEND.md` — UI component data construction, HTMX endpoints, template logic
- `SQL_LOGIC.md` — SQL views, materialized tables, real-time enrichment details
- `DEPLOY.md` — Production deployment via Docker Compose or Proxmox LXCs

## Git Practice
- Never commit with Claude as co-author
- Never push code to remote