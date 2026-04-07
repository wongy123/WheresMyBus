# TESTING.md

Test infrastructure for both the API server (Node.js/Vitest) and the web client (Python/pytest).

## Running the tests

**Server (Node.js)** — no live database or Redis needed:
```bash
cd server
npm test                  # run all tests once
npm run test:watch        # rerun on file changes
npm run test:coverage     # with V8 coverage report
```

**Client (Python)** — no live API server needed:
```bash
cd client
source .venv/bin/activate
python -m pytest tests/ -v
python -m pytest tests/ --cov=. --cov-report=term-missing   # with coverage
```

---

## Server tests — 101 tests across 8 files

Framework: **Vitest** (chosen for native ESM support; the server uses `"type": "module"` which breaks Jest without Babel).

All tests mock external dependencies (ioredis, the `gtfs` npm package, SQLite) via `vi.mock` factory functions so no database or Redis instance is needed.

### `tests/utils/params.test.js` — 13 tests
Tests `parseIntParam` and `parseDirection` in `src/utils/params.js`.

- `parseIntParam`: parses valid integers, returns `undefined` (or a custom default) for non-numeric strings, empty strings, and `undefined` input; truncates floats.
- `parseDirection`: accepts only `0` or `1`, returns a configurable default (normally `0`) for any other value including strings, out-of-range numbers, and `undefined`.

### `tests/utils/paginate.test.js` — 9 tests
Tests `paginateResponse` in `src/utils/paginate.js`.

- Returns the correct data slice and pagination metadata (`page`, `total`, `pageCount`, `hasNext`, `hasPrev`) for page 1 and page 2.
- Returns an empty slice for an out-of-range page.
- Handles an empty input array.
- Clamps `limit` to `maxLimit` to prevent runaway queries.
- Sets the `X-Total-Count` response header when a `res` object is provided.
- Sets the `Link` header with `rel="next"`, `rel="prev"`, `rel="first"`, `rel="last"` relations for middle pages.
- Returns a `links` object with URL strings for each relation.

### `tests/utils/gtfsHelpers.test.js` — 14 tests
Tests four pure helper functions exported from `src/services/gtfsQueries.service.js`.

**`hmsToSec`** — converts `HH:MM:SS` strings to seconds:
- Standard times: `01:00:00` → 3600.
- GTFS overflow times past midnight (e.g. `25:00:00` → 90000), which occur in the static feed for services that run past midnight.
- Returns `null` for invalid inputs: empty string, `null`, `undefined`, wrong number of components, un-padded digits.

**`secToHms`** — converts seconds back to `HH:MM:SS`:
- Standard conversions (`0` → `'00:00:00'`, `86399` → `'23:59:59'`).
- Wraps at 86400 (`'00:00:00'`).
- Returns `null` for `null`, `undefined`, `NaN`.
- Round-trips cleanly with `hmsToSec` for normal time values.

**`haversineM`** — great-circle distance in metres:
- Returns 0 for identical coordinates.
- Is symmetric (A→B = B→A).
- Returns a positive, plausible distance for nearby Brisbane coordinates.
- Returns ~111 km for 1 degree of latitude at the equator (sanity-check against Earth's radius).

**`epochToLocalHms`** — converts a Unix timestamp (seconds) to a local `HH:MM:SS` string using a configurable UTC offset (default GMT+10 for Brisbane):
- Returns `null` for `null`/`undefined`.
- Correctly converts `2024-04-06T00:00:00Z` → `'10:00:00'` in GMT+10.
- Handles the midnight crossing: `2024-04-06T14:00:00Z` → `'00:00:00'` in GMT+10.

### `tests/services/cache.test.js` — 9 tests
Tests `cacheGet`, `cacheSet`, and `cacheMGet` in `src/services/cache.service.js`.

The ioredis `Redis` constructor is mocked using `vi.hoisted()` so the mock functions can be referenced inside `vi.mock`, which is hoisted before imports. `vi.resetAllMocks()` runs before each test.

**`cacheGet`**:
- Returns a parsed JavaScript object on a cache hit (Redis returns a JSON string).
- Returns `null` on a cache miss (Redis returns `null`).
- Returns `null` on a Redis connection error (never throws).
- Returns `null` for malformed JSON stored in Redis.

**`cacheSet`**:
- Calls Redis `SET` with the key, JSON-serialised value, the `EX` flag, and the correct TTL integer.
- Resolves silently even when Redis throws.

**`cacheMGet`**:
- Returns an empty array without calling Redis when given an empty key list (short-circuit).
- Returns parsed values with `null` for misses (mixed hit/miss array).
- Returns an all-`null` array on Redis error.

### `tests/services/gtfsRealtime.test.js` — 12 tests
Tests `buildTripUpdateMap` and `buildVehiclePosMap` in `src/services/gtfsRealtime.service.js`. These are the functions that parse the decoded GTFS-RT protobuf feed into the Maps that get written to Redis.

Uses synthetic feed objects (not real protobuf data) to stay self-contained.

**`buildTripUpdateMap`**:
- Returns an empty Map for an empty feed.
- Skips entities that have no `tripUpdate` field.
- Skips entities whose `tripUpdate` has no `tripId`.
- Maps a single trip update to the correct structure: `updatedAt` (epoch ms), `stopUpdates` array with `stopSequence`, `stopId`, `arrivalDelay`, `departureDelay`, `arrivalTime`, `departureTime`.
- Sets delay and time fields to `null` when the stop update has no `arrival`/`departure` blocks.
- Handles multiple trips in one feed.

**`buildVehiclePosMap`**:
- Returns an empty Map for an empty feed.
- Skips entities with no `vehicle` field.
- Skips vehicles with no `tripId`.
- Maps a vehicle to the correct structure: `latitude`, `longitude`, `vehicleId`, `vehicleLabel`, `currentStopSequence`, `timestamp`, `routeId`, `directionId`.
- Sets all fields to `null` when optional properties (position, vehicle identity, etc.) are absent.
- Handles multiple vehicles.

### `tests/services/rtMerge.test.js` — 26 tests
Tests `applyRealtimeToRow` and `effectiveRowSec` in `src/services/gtfsQueries.service.js`. These are the pure functions that merge real-time data from Redis into a timetable row returned by SQL.

Uses a fixed base timetable row (trip `TRIP_001`, stop `600028`, sequence 5, scheduled departure `09:00:00`) and helpers `makeRt` / `makeSu` / `BASE_VPOS` to build test inputs.

**`applyRealtimeToRow`**:

_No data_
- Returns the exact same object reference when both `rt` and `vpos` are `null` (no allocation).

_Vehicle position only_
- Populates all GPS fields: `vehicle_latitude`, `vehicle_longitude`, `vehicle_id`, `vehicle_label`, `vehicle_current_stop_sequence`, `vehicle_timestamp`, `vehicle_time_local` (epoch → GMT+10 string).
- Sets `real_time_data=1` and `has_gps=1`; leaves `has_rt` unset.
- Does not mutate the original row.

_RT delay (exact stop sequence match)_
- Applies `departureDelay` (seconds) to `scheduled_departure_time` → `estimated_departure_time`; sets `departure_delay` and `has_rt=1`.
- Applies `arrivalDelay` (seconds) to `scheduled_arrival_time` → `estimated_arrival_time`; sets `arrival_delay`.
- Handles negative delays (early service).

_RT absolute timestamps (exact match)_
- Uses `departureTime` (Unix epoch) converted to a local `HH:MM:SS` string when no `departureDelay` is present.
- Same for `arrivalTime`.

_Stop-ID fallback_
- Applies the delay when `stop_sequence` doesn't match but `stop_id` does.

_Preceding stop propagation_
- Delay from a stop update at an earlier sequence **is** propagated to the current stop (`suIsPreceding=true`).
- An absolute timestamp from a preceding stop update is **not** applied — it belongs to that stop, not the current one. Both `estimated_departure_time` and `has_rt` must remain unset.
- When multiple preceding stops exist, uses the closest one (highest sequence number below the current stop).

_No matching stop update_
- `real_time_data` and `has_rt` are not set.
- `realtime_updated_at`, `realtime_updated_local`, and `rt_min_stop_sequence` are still set from the RT metadata.

_`rt_min_stop_sequence`_
- Is the minimum positive, finite `stopSequence` across all stop updates in the RT entry; `null` and zero sequences are filtered out.

_Combined RT + vpos_
- Sets `real_time_data=1`, `has_rt=1`, `has_gps=1`; both delay fields and GPS fields are present.

_Immutability_
- Always returns a new object; never mutates the original row.

**`effectiveRowSec`** — determines the sort-time for a row in seconds:

- Prefers `estimated_departure_time` over all other fields.
- Falls back to `estimated_arrival_time`, then `scheduled_departure_time`, then `scheduled_arrival_time`, then `win_sec`.
- Returns `null` for a completely empty row or `null` input.
- Midnight rollover: adds 86400 when the computed time is more than 12 hours behind `win_sec` (handles services that run past midnight appearing in a near-midnight window).
- No rollover when the gap is 12 hours or less.

### `tests/api/stops.test.js` — 10 tests
Integration tests for the stops API routes using **supertest**. A minimal Express app is created in-process with the real router mounted; the service layer is mocked.

- `GET /stops/search?q=Roma` → 200, paginated body, `X-Total-Count` header.
- `GET /stops/search?q=zzznomatch` → 200, empty `data`, `total=0`.
- Verifies `getAllStops` is called with the `q` parameter.
- `GET /stops/600028` (valid) → 200, correct stop body.
- `GET /stops/UNKNOWN999` → 404 with `{ error: 'Stop not found' }`.
- `GET /stops/600028/timetable` → 200 with two rows.
- `GET /stops/UNKNOWN/timetable` → 404.
- `GET /stops/600028/timetable?routes=66` → 200, only the row with `route_short_name='66'` returned.
- `GET /stops/600028/routes` → 200, routes array.
- `GET /stops/nearby` (no lat/lng) → 400 with error.

### `tests/api/routes.test.js` — 8 tests
Integration tests for the routes API routes using supertest.

- `GET /routes/search?q=66` → 200, paginated, `X-Total-Count`.
- `GET /routes/search?q=ZZZNOMATCH` → 200, empty.
- `GET /routes/66` (valid, service today) → 200; `has_service_today` is stripped from the response body.
- `GET /routes/UNKNOWN999` → 404 with `{ error: 'Route not found' }`.
- `GET /routes/66` (no service today) → 200 with `next_service_date` field populated.
- `GET /routes/66/upcoming?direction=0` → 200, two rows, `X-Total-Count: 2`.
- `GET /routes/66/upcoming?direction=5` → 400 with `{ error: 'direction must be 0 or 1' }`.
- `GET /routes/66/directions` (cache miss) → 200, `available_directions` and `default_direction`.

---

## Client tests — 44 tests across 3 files

Framework: **pytest** with `pytest-mock`.

`conftest.py` installs a shared `api_get` mock into `sys.modules["api"]` before any blueprint imports, so tests can control API responses without a running server.

### `tests/test_helpers.py` — 28 tests
Tests `get_line_names` and `build_display_routes` in `helpers.py`.

**`get_line_names`** (9 tests) — maps train variant codes to human-readable line names:
- Multi-line variants (e.g. `BNVL` → both Gold Coast Line and Beenleigh Line).
- Single-line variants.
- Airport Line override codes (`BRBR`, `BDBR`).
- Variants that span two lines (`CLBR` → Airport + Cleveland).
- Case-insensitive input.
- Unknown codes and empty string return `[]`.

**`build_display_routes`** (19 tests) — transforms raw route objects into display-ready chips:
- Combines duplicate route short names into a single chip.
- Filters by `route_type` when a type filter is specified.
- Handles trains with line names from `get_line_names`.
- Includes route color data.
- Returns an empty list for empty input.
- Handles mixed route types in one stop's routes list.

### `tests/test_api.py` — 7 tests
Tests the `api_get` function in `api.py` (the thin HTTP wrapper around `requests.get`). Loads `api.py` via `importlib.util.spec_from_file_location` to bypass the sys.modules stub that other tests use.

- `requests.get` 200 → returns parsed JSON.
- `requests.get` 404 → returns `None`.
- `requests.get` 500 → raises the exception from `raise_for_status`.
- `params` dict is forwarded as the `params` kwarg to `requests.get`.
- No params → `params={}` forwarded (not `None`).
- The URL is constructed from the path argument.
- A default timeout of 15 seconds is applied.

### `tests/test_blueprints.py` — 9 tests
Tests Flask blueprint routes via the Flask test client. `mock_api` controls what the `api_get` stub returns.

**Stop blueprint**:
- Unknown stop → 404.
- `GET /hx/stops/suggest` with no query → 200, `api_get` not called.
- `GET /hx/stops/suggest?q=Roma` → 200, `api_get` called once with a path containing `stops/search`.
- `GET /hx/stops/nearby` with no coords → 200 (renders error state template, not a 4xx).

**Route blueprint**:
- Unknown route → 404.
- `GET /hx/routes/suggest` with no query → 200, `api_get` not called.
- `GET /hx/routes/suggest?q=66` → 200, `api_get` called with a path containing `routes/search`.

**Home and static**:
- `GET /` → 200.
- `GET /about` → 200.
