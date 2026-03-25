/* diagmap.js — shared stop-modal map logic (route timetable + route details pages)
 * Requires: Leaflet, transit.js, timetable.js
 * _diagBasePath must be set by the template before this file is loaded. */

var _diagMap           = null;
var _diagFocusMarker   = null;
var _diagNearbyMarkers = {};
var _diagRouteMarkers  = {};
var _diagVehicleMarkers = {};
var _diagPolyline      = null;
var _diagMoveTimer     = null;
var _diagFocusStopId   = null;

function _diagDrawRoute() {
  if (_diagPolyline) { _diagMap.removeLayer(_diagPolyline); _diagPolyline = null; }
  Object.values(_diagRouteMarkers).forEach(function (m) { _diagMap.removeLayer(m); });
  _diagRouteMarkers = {};
  var route = window._diagRoute;
  if (!route || !route.stops) return;
  var valid = route.stops.filter(function (s) { return s.stop_lat && s.stop_lon; });

  // Draw stop dot markers
  valid.forEach(function (s) {
    _diagRouteMarkers[s.stop_id] = L.marker([s.stop_lat, s.stop_lon], { icon: window.TRANSIT.makeRouteDot(route.color) })
      .addTo(_diagMap)
      .bindPopup(window.TRANSIT.makeStopPopup(s, _diagBasePath));
  });

  // Fetch GTFS shape and draw polyline following the actual route path
  fetch(window.API_BASE_URL + '/routes/' + route.routeId + '/shape?direction=' + route.direction)
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var coords = (data.data || []).map(function (p) { return [p.lat, p.lon]; });
      if (coords.length < 2) coords = valid.map(function (s) { return [s.stop_lat, s.stop_lon]; });
      if (_diagPolyline) _diagMap.removeLayer(_diagPolyline);
      _diagPolyline = L.polyline(coords, { color: route.color, weight: 4, opacity: 0.75, lineJoin: 'round' }).addTo(_diagMap);
    })
    .catch(function () {
      // Fall back to stop-to-stop straight lines on error
      if (valid.length >= 2 && !_diagPolyline)
        _diagPolyline = L.polyline(
          valid.map(function (s) { return [s.stop_lat, s.stop_lon]; }),
          { color: route.color, weight: 4, opacity: 0.75, lineJoin: 'round' }
        ).addTo(_diagMap);
    });
}

function _diagFitRoute() {
  if (_diagPolyline) _diagMap.fitBounds(_diagPolyline.getBounds(), { padding: [20, 20] });
}

function _diagLoadNearby() {
  var center = _diagMap.getCenter();
  fetch(window.API_BASE_URL + '/stops/nearby?lat=' + center.lat + '&lng=' + center.lng + '&limit=30')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      Object.values(_diagNearbyMarkers).forEach(function (m) { _diagMap.removeLayer(m); });
      _diagNearbyMarkers = {};
      (data.data || []).forEach(function (s) {
        if (!s.stop_lat || !s.stop_lon || s.stop_id === _diagFocusStopId || _diagRouteMarkers[s.stop_id]) return;
        _diagNearbyMarkers[s.stop_id] = L.marker([s.stop_lat, s.stop_lon], { icon: window.TRANSIT.makeStopIcon(s) })
          .addTo(_diagMap).bindPopup(window.TRANSIT.makeStopPopup(s, _diagBasePath));
      });
    })
    .catch(function () {});
}

function _diagSetFocus(stopName, lat, lon) {
  _diagDrawRoute();
  _diagDrawVehicles();
  if (_diagFocusMarker) _diagMap.removeLayer(_diagFocusMarker);
  _diagFocusMarker = L.marker([lat, lon]).addTo(_diagMap)
    .bindPopup('<b>' + stopName + '</b><br><span class="map-popup-meta">Selected stop</span>')
    .openPopup();
  _diagMap.setView([lat, lon], 16);
  _diagLoadNearby();
}

function _diagDrawVehicles() {
  if (!_diagMap) return;
  var route = window._diagRoute;
  if (!route || !route.vehicles) return;
  window.TRANSIT.updateVehicleMarkers(_diagMap, _diagVehicleMarkers, route.vehicles, {
    makePopup: function (v) {
      return window.TRANSIT.routeVehiclePopup({
        headsign: v.headsign || '',
        label: v.label || '',
        stopName: v.stop_name || '',
        etaStr: v.minutes_away != null ? window.fmtMins(v.minutes_away) : ''
      });
    },
    getColor:    function () { return route.color; },
    getIconName: function () { return route.vehicleIcon; }
  });
}

function showStopMap(stopId, stopName, lat, lon) {
  _diagFocusStopId = stopId;
  document.getElementById('stopMapModalLabel').textContent = stopName;
  document.getElementById('diagram-stop-link').href = _diagBasePath + '/stops/' + stopId;
  var modalEl = document.getElementById('stopMapModal');
  if (_diagMap && modalEl.classList.contains('show')) {
    _diagSetFocus(stopName, lat, lon);
    return;
  }
  modalEl.addEventListener('shown.bs.modal', function () {
    if (!_diagMap) {
      _diagMap = L.map('diagram-stop-map').setView([lat, lon], 16);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19
      }).addTo(_diagMap);
      _diagMap.on('moveend', function () {
        clearTimeout(_diagMoveTimer);
        _diagMoveTimer = setTimeout(_diagLoadNearby, 400);
      });
    } else {
      _diagMap.invalidateSize();
    }
    _diagSetFocus(stopName, lat, lon);
  }, { once: true });
  bootstrap.Modal.getOrCreateInstance(modalEl).show();
}
