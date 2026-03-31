# WheresMyBus — Frontend Data Construction

This document describes how every API-driven UI component is built: which endpoints are called, what data is received, and how it is transformed into the rendered output.

---

## Architecture Overview

The frontend is **Python/Flask** with **HTMX** for partial updates. The two rendering paths are:

- **Server-side (Flask)**: Python blueprints call the API via `api.py → api_get()` (a `requests.get` wrapper hitting `API_BASE_URL`), then render a Jinja2 template with the result.
- **Client-side (browser)**: JavaScript directly `fetch()`es `window.API_BASE_URL` (injected by Flask into the base template) and manipulates the DOM.

Shared JS helpers:
- `static/timetable.js` — time/delay formatting (`gtfsTime`, `gtfsDelay`, `fmtMins`, `minsFromNow`, `formatGtfsTime`, `delayInfo`, `initTimetableFragment`)
- `static/transit.js` — route-type colours, Leaflet icon factories (`makeStopIcon`, `makeVehicleIcon`, `makeRouteDot`), stop popup HTML (`makeStopPopup(s, basePath)`), vehicle popup builders (`stopVehiclePopup`, `routeVehiclePopup`), and vehicle marker sync (`updateVehicleMarkers`)
- `static/diagmap.js` — stop-modal map logic (`showStopMap`, all `_diag*` functions) shared between the route timetable page and the route details page. Requires `_diagBasePath` to be set before loading.

---

## Stop Timetable

**Page**: `/timetable/stop/<stop_id>` (`timetable.py → timetable_by_stop`)

### Initial page load

Flask calls `GET /api/stops/<stop_id>` to get the stop name/code for the page heading.
If `location_type == 1` (a parent station), it also calls `GET /api/stops/<stop_id>/platforms` to list the platform links at the top of the page.

The timetable table itself is an **empty div** on page load — HTMX fills it immediately via `hx-trigger="load, every 5s"`.

The same fragment is also embedded on the **stop details page** (`/stops/<stop_id>`) with `hx-trigger="load, every 5s"` (faster rate to stay in sync with the vehicle position poll on that page).

### Timetable fragment (`/hx/timetable/stop/<stop_id>`)

Flask calls `GET /api/stops/<stop_id>/timetable?page=&limit=&duration=`.

The server returns an array of rows (one per upcoming service), each containing:

```
route_short_name, route_color, route_text_color
trip_headsign, stop_sequence
scheduled_arrival_time, scheduled_departure_time
estimated_arrival_time, estimated_departure_time
arrival_delay, departure_delay
real_time_data
realtime_updated_at
platform_code          (stations only)
```

**Time display** (`_timetable_row.html → stop_row` macro):
- `main_time = estimated_departure || estimated_arrival || scheduled_departure || scheduled_arrival`
- Rendered as a `<span class="tt-time" data-time="HH:MM">` with two inner spans: `.tt-min` (minutes countdown, shown by default) and `.tt-abs` (clock time, hidden). Clicking toggles between them.
- `initTimetableFragment()` populates `.tt-min` using `fmtMins(minsFromNow(el.dataset.time))` on the client.

**Status badge** (`delay_info` Jinja filter):
- `delay = departure_delay ?? arrival_delay ?? null`
- `null` → "Scheduled" (grey)
- `abs(delay) < 30s` → "On time" (green)
- `>= 30s late` → "Nm late" (amber)
- `>= 30s early` → "Nm early" (cyan)

**RT icon**: shown only when `real_time_data == 1` and status is late/early/ontime. Colour indicates freshness: `< 120 s` → green, `< 180 s` → orange, else red. Age computed from `realtime_updated_at` (millisecond epoch).

**ETA source (server-side, `applyRealtimeToRow`)**: GTFS-RT stop updates are matched to a timetable row first by exact `stop_id`/`stop_sequence`, then by falling back to the closest preceding stop update if no exact match exists. When a preceding stop is used (`suIsPreceding = true`), the absolute `arrivalTime`/`departureTime` timestamps from that update are **not** applied to `estimated_arrival_time`/`estimated_departure_time` — those timestamps belong to the preceding stop, not the queried stop. Only delay offsets (`scheduleRelationship` + delay) are applied from preceding stops. This prevents ETA from showing the wrong stop's departure time.

**Popover on status badge**: shows `"est HH:MM · sched HH:MM"` when estimated ≠ scheduled, otherwise just the scheduled time.

**Auto-refresh**: HTMX polls every 5s on both the timetable page and the stop details page. Both use the same mechanism: `hx-vals='js:{...}'` with a dynamic expression that reads `data-tt-page` from a hidden `<span>` rendered inside the fragment. This carries the current page number into each poll request so the displayed page stays stable across refreshes. If the current page no longer exists (total results dropped), the fragment script fires an immediate HTMX request to jump to the last valid page.

**Client-side re-sort**: After each HTMX swap, rows are re-sorted in the DOM by `minsFromNow(data-time)`. This corrects any ordering drift caused by rendering at a slightly different moment than the server sorted.

---

## Station Timetable

Same page and HTMX fragment as the stop timetable — the same `/hx/timetable/stop/<stop_id>` URL is used.

The distinction is handled entirely server-side in `getUpcomingByStation`. When the stop ID is a parent station (`location_type == 1`), the server queries all child platform IDs together and adds `platform_code` to each row. The fragment template (`_stop_results.html`) checks:

```jinja
{% set has_platforms = rows | selectattr('platform_code') | list | length > 0 %}
```

If any row has a `platform_code`, an extra "Plat." column is shown in the table.

---

## Route Timetable (Table View)

**Page**: `/timetable/route/<route_id>` (`timetable.py → timetable_by_route`)

### Initial page load

Flask calls `GET /api/routes/<route_id>` for the route name/colour/type displayed in the header. The timetable table div starts hidden (`d-none`) and is triggered into view only when the user clicks "Table".

### Table fragment (`/hx/timetable/route/<route_id>/upcoming`)

Flask calls `GET /api/routes/<route_id>/upcoming?direction=&duration=&page=&limit=`.

Returns one row per in-service trip (the next stop each trip is heading to). Columns:

- **Time**: same `tt-time` toggle as stop timetable
- **Stop**: the next stop name, linked to `/stops/<stop_id>`
- **Headsign**: destination text
- **Leg**: `stop_sequence / total_stops` (e.g. "4 / 22"), hidden on mobile. Falls back to `#sequence` if total is unknown.
- **Status**: same delay badge + RT icon logic as stop rows

Auto-refreshes every 5 seconds via `setInterval` triggering an HTMX `refresh` event (started when switching to table view, stopped when switching away).

---

## Route Diagram

**Page**: `/timetable/route/<route_id>` (same page, diagram tab is default)

### Diagram fragment (`/hx/timetable/route/<route_id>/diagram`)

Flask makes three API calls in parallel:

1. `GET /api/routes/<route_id>` — route colour and type (for icon/colour selection)
2. `GET /api/routes/<route_id>/stops?direction=` — canonical ordered stop list
3. `GET /api/routes/<route_id>/upcoming?direction=&duration=&limit=100` — all active trips

**`minutes_away` calculation** (Python, in `timetable.py`):

```python
eta_str = estimated_departure || scheduled_departure || estimated_arrival || scheduled_arrival
eta_sec = hms_to_sec(eta_str)
diff = eta_sec - now_sec
if diff < -3600: diff += 86400   # midnight rollover
minutes_away = max(0, round(diff / 60))
```

**`vehicles_by_seq` mapping** (Python):

Each trip's `stop_id` is resolved to a canonical sequence via `stop_id_to_seq` (built from the `/stops` response). This normalises across trips that may number stops differently. The sequence is then passed through `_advance_seq`:

- If `real_time_data` is set and `estimated_departure` for the reported stop has already passed, the stop advances by one position. This handles the bus having just departed.
- Result: a dict of `seq → [list of trip rows]`, used by the template to place vehicle cards above the correct stop dot.

**`vehicle_positions` list** (Python, for the map):
- Trips with GPS data are collected (deduplicated by `trip_id`), using the same `stop_id_to_seq` canonical resolution and `_advance_seq` logic as `vehicles_by_seq`.
- The stop name shown in the map popup comes from `seq_to_stop_name[adv_seq]` (canonical name at the advanced position), falling back to the raw `stop_name` from the trip row.
- If `_advance_seq` advanced the position, `minutes_away` is set to `None` (the ETA to the advanced stop is unknown — the original ETA was to the previous stop).

**Template rendering** (`_route_diagram.html`):

The template iterates `stops` in order. For each stop:
1. Any vehicle cards in `vehicles_by_seq[seq]` are rendered above the stop dot. Each card shows: a circular route-coloured vehicle icon (matching the map marker style), delay badge, minutes/clock time, RT freshness icon.
2. A bouncing arrow is shown if any vehicles are heading to this stop.
3. The stop dot (blue border if vehicles, grey otherwise) and stop name button are rendered.

**`window._diagRoute` object** is serialised into the page at the bottom of the fragment:
```javascript
window._diagRoute = { stops, color, vehicleIcon, routeId, direction, vehicles }
```
This is consumed by the route map in the stop modal (see below).

Auto-refreshes every 5 seconds via HTMX `refresh` event.

---

## Route Schedule Grid

**Fragment**: `/hx/timetable/route/<route_id>/schedule` (`timetable.py → hx_timetable_route_schedule`)

Flask calls `GET /api/routes/<route_id>/schedule?direction=`.

The server returns:
- `stops`: ordered list of stops (canonical trip, most stops)
- `trips`: list of `{ trip_id, headsign, firstDep, times: { stop_id → "HH:MM" } }`

Rendered as a 2D grid (`_route_schedule.html`):
- Rows = stops (frozen left column)
- Columns = trips sorted by first departure (frozen header row)
- Cells = `trip.times[stop.stop_id]` or "—" if that trip skips the stop
- Scrollable both horizontally and vertically (`overflow-x: auto; max-height: 70vh`)

No live data or auto-refresh — purely scheduled departure times for today.

---

## Stop Details Page — Vehicle Map

**Page**: `/stops/<stop_id>` (`stop.py → stop_details`)

### Vehicle positions polling

A hidden `<div>` polls `GET /hx/stops/<stop_id>/vehicles?duration=3600` every 5 seconds via HTMX. The Flask handler (`hx_stop_vehicles`) calls `GET /api/stops/<stop_id>/timetable?limit=50&duration=3600`, then filters the result to rows that have both `vehicle_latitude` and `vehicle_longitude`. It builds a `vehicles` list with:

```python
{ trip_id, route_id, route_short_name, route_color, route_text_color,
  trip_headsign, direction_id, lat, lon, label,
  eta: estimated_departure || scheduled_departure || estimated_arrival || scheduled_arrival }
```

The hidden HTMX div renders `_vehicle_positions.html`, which calls `window.stopMapAddVehicles(vehicles)` via an inline script tag. This function (defined in `stops/details.html`) stores the full vehicle list in `_lastStopVehicles` then delegates to `window._renderFilteredVehicles()`, which applies the active route filter (see below) and calls `window.TRANSIT.updateVehicleMarkers(map, vehicleMarkerMap, toShow, opts)` to update vehicle markers on the Leaflet map in-place — existing markers are moved, new ones are added, departed ones are removed. An `onNewMarker` callback attaches click (draw route polyline) and `popupclose` (clear polyline) handlers to new markers.

**Vehicle popup** (constructed in `stopMapAddVehicles`):
- Route short name + vehicle label
- Headsign
- ETA: computed client-side from `v.eta` using the same seconds-since-midnight arithmetic as `minsFromNow`
- "View Route" link

**Vehicle marker click**: fetches `GET /api/routes/<route_id>/shape?direction=` and draws a polyline on the stop map. The polyline is removed when the popup closes.

### Stop map initial markers

On page load, the stop's own coordinates and the pre-fetched `nearby` stops (up to 8, excluding the current stop) are placed as Leaflet markers using `window.TRANSIT.makeStopIcon(s)`. On map pan/zoom (`moveend`), the center coordinates are sent to `GET /api/stops/nearby?lat=&lng=&limit=30` and the result replaces dynamic markers (skipping the current stop and any already in the static nearby list).

The current stop marker uses a larger white-bordered dot whose colour is derived from the dominant route type among the routes serving this stop (priority: rail > tram > ferry > bus).

### Route filter

At the top of the stop details page, each route serving the stop is shown as a clickable badge. Clicking a badge toggles it active; multiple badges can be active simultaneously. The filtering is entirely **client-side** — the server always returns all buses regardless of which routes are active.

**Timetable rows**: `applyFilter()` shows/hides `<tr data-route="...">` rows in the timetable tbody based on the set of active route names. No server request is made.

**Pagination nav**: when any filter is active, `#stop-timetable` receives the CSS class `filter-active`. The rule `#stop-timetable.filter-active nav { display: none !important; }` permanently hides the pagination nav. Since HTMX swaps `innerHTML` (not the element itself), the class persists across every poll cycle, so any nav the server renders is hidden immediately by CSS without timing dependencies.

**Re-application after poll**: `document.addEventListener('htmx:afterSwap', ...)` listens for swaps targeting `#stop-timetable` (identified via `evt.detail.target`). On each swap, `applyFilter()` runs synchronously — before the browser has a chance to paint — so newly loaded rows are filtered in the same frame as the content swap with no visible flash.

**Vehicle markers**: `window._renderFilteredVehicles()` (exposed on the map script) filters `_lastStopVehicles` by `route_short_name` against the active set, then calls `updateVehicleMarkers` with only the matching vehicles. `applyFilter()` calls this at the end of every invocation, keeping the map and timetable in sync.

**Page reset**: when the user changes the active filter (badge click or clear), `data-tt-page` is reset to `'1'` so the next 5s poll fetches page 1. This reset does NOT happen when `applyFilter()` is called by the `htmx:afterSwap` listener (preserving the current page across background polls).

---

## Map Page — Stop Markers

**Page**: `/map`

### Bounds-based stop loading

On every `moveend` (and on initial load), `loadBoundsMarkers()` calls:

```
GET /api/stops/bounds?north=&south=&east=&west=&types=&limit=750
```

Types are the active filter values (a subset of `[0, 2, 3, 4]` controlled by the filter bar buttons). If the response returns ≥ 750 stops (too zoomed out), all markers are cleared rather than flooding the map.

Each stop is rendered with `window.TRANSIT.makeStopIcon(s)` using `s.primary_route_type` (from the pre-computed `stop_route_type` table) and `s.location_type`. Clicking a marker calls `openSidebar(...)`.

Route stop dots (from `drawRouteShape`) take priority: if a stop is in `activeRouteStopIds`, `addStopMarker` skips it (unless it's the currently selected stop). When `clearShape()` runs, it restores badge markers for any route-stop that is within the current viewport.

---

## Map Page — Sidebar Timetable

When any stop marker is clicked, `openSidebar(stopId, stopName, stopCode, lat, lon)` is called:

1. The sidebar slides in and shows a loading spinner.
2. `GET /api/stops/<stop_id>/timetable?limit=15&duration=3600` is fetched directly from the browser.
3. `renderDepartures(rows)` builds the departure list in JavaScript (no server-side template). For each row:
   - **Route badge**: coloured span using `row.route_color` / `row.route_text_color`
   - **Headsign**: `row.trip_headsign`
   - **Time**: emits a `<span class="tt-time" data-time="HH:MM">` with `.tt-min` / `.tt-abs` inner spans — same pattern as the stop timetable. `initTimetableFragment()` is called after rows are inserted to populate the countdown, wire the click toggle, and colour RT icons.
   - **Delay badge**: `window.delayInfo(window.gtfsDelay(row))` → label, background, foreground colour (same `abs(delay) < 30s` → "On time" threshold as the Jinja filter)
   - **RT icon**: shown when `real_time_data` is set and status is not "Scheduled" — same `rt-icon` markup as the stop timetable, coloured by `initTimetableFragment`

Clicking a departure row calls `drawRouteShape(...)` (see below). A second click on the same row (detected by comparing `activeShapeKey = route_id + '_' + direction_id + '_' + trip_id`) clears the shape.

The "Full timetable" button navigates to `BASE_PATH + '/timetable/stop/' + currentStopId`.

**Auto-refresh while a stop is open**: `openSidebar` starts a `setInterval` (5 s, stored in `sidebarPollInterval`) that calls `refreshSidebar()`. `refreshSidebar` re-fetches `GET /api/stops/<stop_id>/timetable?limit=15&duration=3600` and calls `renderDepartures(rows)` again. The interval is cleared by `closeSidebar`. This keeps both the departure list and all vehicle marker positions up to date without user interaction.

`renderDepartures` calls `updateSidebarVehicles(rows)` after each render:
- If there is an `activeVehicleMarker` (the vehicle placed by `drawRouteShape`), its position is updated in-place via `setLatLng` if a matching `trip_id` row has fresh GPS data.
- All other rows that have GPS coordinates are gathered into a `vehicles` array and passed to `window.TRANSIT.updateVehicleMarkers(map, sidebarVehicleMarkers, vehicles, opts)`. This maintains a `sidebarVehicleMarkers` dict (`trip_id → L.Marker`) — existing markers are moved, new ones are added, departed ones are removed. Their popups use `window.TRANSIT.stopVehiclePopup(...)` with countdown ETA computed from the timetable row's scheduled/estimated time.

---

## Map Page — Route and Vehicle Display

`drawRouteShape(routeId, directionId, routeColor, routeType, vLat, vLon, vPopup, shapeKey, tripId)` is called when a sidebar departure row is clicked.

Two API calls are made in parallel:
1. `GET /api/routes/<routeId>/shape?direction=` — polyline coordinates
2. `GET /api/routes/<routeId>/stops?direction=` — stop positions for route dots

**Polyline**: drawn with the route colour, weight 5, opacity 0.8.

**Route stop dots**: for each stop in the `/stops` response, any existing badge marker for that `stop_id` is removed from the map and `stopMarkerMap` first. A marker is added using `window.TRANSIT.makeRouteDot(color)` (12px white-filled dot with a coloured border, `zIndexOffset: 300`). Clicking a dot opens the sidebar for that stop.

**Vehicle marker**: if `vLat`/`vLon` are provided (the vehicle had GPS data in the timetable row), a vehicle marker is placed using `window.TRANSIT.makeVehicleIcon(color, vehicleIcon)` at `zIndexOffset: 1000`. The map animates (`flyTo`) to the vehicle position. The popup shows: route short name, vehicle label, headsign, ETA in minutes.

**Vehicle popup content** is built in the click handler from the timetable row data, using `window.gtfsTime(row)` + `minsFromNow` for ETA.

`tripId` is stored in `activeTripId`. On entry, if `sidebarVehicleMarkers[tripId]` already exists (from the background vehicle loop), that marker is removed before the dedicated `activeVehicleMarker` is created — preventing duplicate markers for the same vehicle. `clearShape()` resets `activeTripId = null`, which causes `updateSidebarVehicles` to treat that trip as a regular sidebar vehicle on the next refresh.

---

## Map Page — Search

The search input debounces at **400 ms**. On ≥ 2 characters, two requests fire in parallel:

1. `GET /api/stops/search?q=` — stop results, up to 5 shown under "Stops" section
2. `GET /api/geocode?q=` — Nominatim place results, up to 5 shown under "Places" section

**Stop selected**: `clearStopMarkers()`, `addStopMarker(s)` (places the stop marker), `map.flyTo(stop_lat, stop_lon, 17)`, then `openSidebar(...)` to load the timetable.

**Place selected**: a red `location_on` pin is placed at the lat/lon with a popup showing the `display_name`. `map.flyTo` to that position at zoom 15, which triggers `moveend` → `loadBoundsMarkers()` to show nearby stops.

---

## Map Page — Geolocation

**On page load**: `navigator.geolocation.getCurrentPosition` is called silently (no error alert). If permission is already granted, `map.setView(lat, lon, 15)` centres the map without animation and a `person_pin_circle` marker is placed at `zIndexOffset: 800`.

**"Locate me" button**: same `getCurrentPosition` call but uses `map.flyTo` (animated) and calls `loadNearby(lat, lon)` which triggers `loadBoundsMarkers()` after the flyTo completes.

---

## Other API-Driven Components

### Stop search suggest (`/hx/stops/suggest`)

Used on the home page and stop search box. HTMX fires on `input` with `hx-trigger="input changed delay:300ms"`. Flask calls `GET /api/stops/search?q=&page=&limit=` and renders `_suggest.html` with paginated results. The `dest` parameter controls whether links point to `/stops/<id>` or `/timetable/stop/<id>`.

### Route search suggest (`/hx/routes/suggest`)

Same pattern. Flask calls `GET /api/routes/search?q=&page=&limit=` and renders `_suggest.html`.

### Nearby stops widget (`/hx/stops/nearby`)

Used on the home page. Browser requests the user's GPS position and submits lat/lng as query params via HTMX. Flask calls `GET /api/stops/nearby?lat=&lng=&limit=` and renders `_nearby.html`.

### Nearby stops JSON (`/hx/stops/nearby-json`)

Used by map pages. Returns `{ data: [...] }` JSON directly. Called with `limit=8` for the home page and `limit=30` for stop detail map panning.

### Stop details page load (`/stops/<stop_id>`)

Flask makes up to four calls at page load:
1. `GET /api/stops/<stop_id>` — stop name, code, coordinates, location_type
2. `GET /api/stops/nearby?lat=&lng=&limit=9` — up to 8 nearby stops (current stop excluded; only called if the stop has coordinates)
3. `GET /api/stops/<stop_id>/routes` — all routes serving this stop (shown as coloured filter badges)
4. `GET /api/stops/<stop_id>/platforms` — if `location_type == 1` (station)

### Route details page load (`/routes/<route_id>`)

Flask calls `GET /api/routes/<route_id>` for the route name, colour, type, and ID. The diagram and upcoming tabs are loaded lazily via HTMX after the page renders.

### Route timetable page — stop modal map

All stop-modal map logic lives in `static/diagmap.js` (shared with `routes/details.html`). Each template sets `_diagBasePath` then loads `diagmap.js`.

When a stop name button is clicked in the route diagram, `showStopMap(stopId, stopName, lat, lon)` opens a Bootstrap modal containing a Leaflet map. This map:
1. Draws route stop dots using `window.TRANSIT.makeRouteDot(route.color)` and polyline from `window._diagRoute` (serialised into the page by the diagram fragment — no additional API call needed for the stops/shape).
2. Fetches `GET /api/routes/<routeId>/shape?direction=` to draw the polyline (the shape coordinates are not in `_diagRoute.stops`, only stop coords are).
3. On map `moveend`, fetches `GET /api/stops/nearby?lat=&lng=&limit=30` and places nearby stop markers using `window.TRANSIT.makeStopIcon` (excluding the focused stop and route stops).
4. Draws vehicle markers from `_diagRoute.vehicles` using `window.TRANSIT.updateVehicleMarkers` (via `_diagDrawVehicles()`).

On the route timetable page, an `htmx:afterSettle` listener on `#tt-route-diagram` calls `_diagDrawVehicles()` to refresh vehicle positions after each HTMX poll. On the route details page, the same listener fires for `#route-diagram` and calls both `_diagDrawVehicles()` and `_pageMapDrawVehicles()`.
