# Performance & Correctness Fixes Design

**Date:** 2026-04-03

## Scope

Three targeted fixes for timetable flicker, Leaflet map memory leak, and GPS debouncing.

---

## 6.1 Timetable re-sort flicker (`_stop_results.html`)

**Problem:** After each HTMX refresh the inline script re-sorts `<tbody>` rows by calling `tbody.appendChild(tr)` once per row, causing N sequential DOM mutations that produce a visible repaint flash.

**Fix:** Collect the sorted rows into a `DocumentFragment` (which removes them from the live DOM in one pass), then re-insert with a single `tbody.appendChild(fragment)` call. N mutations → 1 mutation, no intermediate repaints.

Active-row highlight is already preserved by the `htmx:afterSwap` listener in `stops/details.html` — no change needed there.

---

## 6.2 Map instance leak on modal close (`diagmap.js`)

**Problem:** `_diagMap` is created once per `shown.bs.modal` and is never destroyed. Closing and reopening the modal accumulates Leaflet instances, tile layer connections, and marker objects in memory.

**Fix:** In the `hidden.bs.modal` handler inside `_diagInitModal`, after `_diagStopFollow()`:
- Call `_diagMap.remove(); _diagMap = null;`
- Null out `_diagFocusMarker`, `_diagPolyline`
- Reset `_diagNearbyMarkers`, `_diagRouteMarkers`, `_diagVehicleMarkers` to `{}`
- Clear any pending `_diagMoveTimer`

This is safe because `showStopMap`/`showVehicleMap` always check `if (_diagMap && modal.is('show'))` before skipping `_diagInitModal` — with `_diagMap` null, they always take the init path.

---

## 6.3 GPS watch debounce (6 files)

**Problem:** `watchPosition` callbacks fire at device update rate (can be multiple times per second). Each callback calls marker-update and, in some pages, triggers HTMX requests for nearby stops.

**Fix:** Add a `var lastGpsUpdate = 0` per watchPosition scope. At the top of each success callback:
```js
var now = Date.now();
if (now - lastGpsUpdate < 1000) return;
lastGpsUpdate = now;
```

Files to update:
- `client/templates/home.html`
- `client/templates/common/_stop_search.html`
- `client/templates/map.html`
- `client/templates/routes/index.html`
- `client/templates/routes/details.html`
- `client/templates/stops/details.html`
