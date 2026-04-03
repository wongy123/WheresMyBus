/* diagmap.js — shared stop/vehicle modal map logic (route timetable + route details pages)
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
var _diagFollowTripId  = null;
var _diagFollowTimer   = null;
var _diagUserPaused    = false;

function _diagDrawRoute() {
  if (_diagPolyline) { _diagMap.removeLayer(_diagPolyline); _diagPolyline = null; }
  Object.values(_diagRouteMarkers).forEach(function (m) { _diagMap.removeLayer(m); });
  _diagRouteMarkers = {};
  var route = window._diagRoute;
  if (!route || !route.stops) return;
  var valid = route.stops.filter(function (s) { return s.stop_lat && s.stop_lon; });

  // Draw stop dot markers
  valid.forEach(function (s) {
    _diagRouteMarkers[s.stop_id] = L.marker([s.stop_lat, s.stop_lon], { icon: window.TRANSIT.makeRouteDot(route.color), zIndexOffset: s.location_type === 1 ? 200 : 100 })
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
        _diagNearbyMarkers[s.stop_id] = L.marker([s.stop_lat, s.stop_lon], { icon: window.TRANSIT.makeStopIcon(s), zIndexOffset: s.location_type === 1 ? 200 : 100 })
          .addTo(_diagMap).bindPopup(window.TRANSIT.makeStopPopup(s, _diagBasePath));
      });
    })
    .catch(function () {});
}

function _diagSetFocus(stopName, lat, lon) {
  _diagDrawRoute();
  _diagDrawVehicles();
  if (_diagFocusMarker) _diagMap.removeLayer(_diagFocusMarker);
  _diagFocusMarker = L.marker([lat, lon], { zIndexOffset: 1500 }).addTo(_diagMap)
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

function _diagStopFollow() {
  _diagFollowTripId = null;
  _diagUserPaused = false;
  if (_diagFollowTimer) { clearInterval(_diagFollowTimer); _diagFollowTimer = null; }
  var badge = document.getElementById('diagram-follow-badge');
  if (badge) badge.style.display = 'none';
  var recenter = document.getElementById('diagram-recenter-btn');
  if (recenter) recenter.style.display = 'none';
  var link = document.getElementById('diagram-stop-link');
  if (link) link.style.display = '';
}

function _diagUpdateFollowFooter(stopName, minutesAway, delaySec) {
  var badge = document.getElementById('diagram-follow-badge');
  if (!badge) return;
  var etaStr = minutesAway !== '' && minutesAway != null ? window.fmtMins(parseFloat(minutesAway)) : '';
  var info = window.delayInfo(delaySec !== '' && delaySec != null ? Number(delaySec) : null);
  var html = '<span class="badge me-1" style="background:' + info.bg + ';color:' + info.fg + ';">' + info.label + '</span>';
  var detail = '';
  if (stopName) detail += '<span class="fw-semibold">' + stopName + '</span>';
  if (stopName && etaStr) detail += '<span class="text-muted mx-1">·</span>';
  if (etaStr) detail += '<span>' + etaStr + '</span>';
  if (detail) html += '<span class="d-none d-sm-inline">' + detail + '</span>';
  badge.innerHTML = html;
}


function _diagResumeFollow() {
  _diagUserPaused = false;
  var recenter = document.getElementById('diagram-recenter-btn');
  if (recenter) recenter.style.display = 'none';
  if (_diagFocusMarker) _diagMap.panTo(_diagFocusMarker.getLatLng());
}

function showStopMap(stopId, stopName, lat, lon) {
  _diagStopFollow();
  _diagFocusStopId = stopId;
  document.getElementById('stopMapModalLabel').textContent = stopName;
  document.getElementById('diagram-stop-link').href = _diagBasePath + '/stops/' + stopId;
  document.getElementById('diagram-stop-link').style.display = '';
  var modalEl = document.getElementById('stopMapModal');
  if (_diagMap && modalEl.classList.contains('show')) {
    _diagSetFocus(stopName, lat, lon);
    return;
  }
  _diagInitModal(lat, lon, function () {
    _diagSetFocus(stopName, lat, lon);
  });
}

function _diagInitModal(lat, lon, onReady) {
  var modalEl = document.getElementById('stopMapModal');
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
      _diagMap.on('dragstart', function () {
        if (_diagFollowTripId) {
          _diagUserPaused = true;
          var recenter = document.getElementById('diagram-recenter-btn');
          if (recenter) recenter.style.display = '';
        }
      });
    } else {
      _diagMap.invalidateSize();
    }
    onReady();
  }, { once: true });

  // Stop following when modal closes
  modalEl.addEventListener('hidden.bs.modal', function () {
    _diagStopFollow();
  }, { once: true });

  bootstrap.Modal.getOrCreateInstance(modalEl).show();
}

function _diagSetVehicleFocus(label, headsign, lat, lon, minutesAway, stopName) {
  _diagDrawRoute();
  _diagDrawVehicles();
  if (_diagFocusMarker) _diagMap.removeLayer(_diagFocusMarker);

  var route = window._diagRoute || {};
  var color = route.color || '#6c757d';
  var iconName = route.vehicleIcon || 'directions_bus';
  var focusIcon = L.divIcon({
    className: '',
    html: '<div style="width:32px;height:32px;background:' + color + ';border-radius:50%;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;">' +
          '<span class="material-symbols-outlined" style="font-size:1.1rem;color:white;line-height:1;">' + iconName + '</span></div>',
    iconSize: [32, 32],
    iconAnchor: [16, 16]
  });

  _diagFocusMarker = L.marker([lat, lon], { icon: focusIcon, zIndexOffset: 2000 }).addTo(_diagMap);
  var popup = '<b>' + (label || 'Vehicle') + '</b>';
  if (headsign) popup += '<br><span class="text-muted small">' + headsign + '</span>';
  if (stopName) popup += '<br><span class="small">Next: ' + stopName + '</span>';
  if (minutesAway !== '') popup += '<br><span class="small fw-semibold">' + window.fmtMins(parseFloat(minutesAway)) + '</span>';
  _diagFocusMarker.bindPopup(popup, { autoPan: false }).openPopup();
  _diagMap.setView([lat, lon], Math.max(_diagMap.getZoom(), 16));
  _diagLoadNearby();
}

function _diagFollowVehicle(tripId) {
  var route = window._diagRoute || {};
  fetch(window.API_BASE_URL + '/routes/' + route.routeId + '/upcoming?direction=' + route.direction + '&limit=200')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var rows = data.data || data.items || [];
      var match = rows.find(function (r) { return r.trip_id === tripId && r.vehicle_latitude && r.vehicle_longitude; });
      if (!match || !_diagFollowTripId) return;
      var lat = match.vehicle_latitude;
      var lon = match.vehicle_longitude;
      var minutesAway = match.minutes_away != null ? String(match.minutes_away) : '';
      var stopName = match.stop_name || '';
      var headsign = match.trip_headsign || '';
      var label = match.vehicle_label || match.vehicle_id || '';

      // Update title and badge
      document.getElementById('stopMapModalLabel').textContent = label || 'Vehicle';
      var delaySec = match.departure_delay != null ? match.departure_delay :
                     match.arrival_delay   != null ? match.arrival_delay : null;
      _diagUpdateFollowFooter(stopName, minutesAway, delaySec);

      // Move the focus marker
      if (_diagFocusMarker) {
        _diagFocusMarker.setLatLng([lat, lon]);
        var popup = '<b>' + (label || 'Vehicle') + '</b>';
        if (headsign) popup += '<br><span class="text-muted small">' + headsign + '</span>';
        if (stopName) popup += '<br><span class="small">Next: ' + stopName + '</span>';
        if (minutesAway !== '') popup += '<br><span class="small fw-semibold">' + window.fmtMins(parseFloat(minutesAway)) + '</span>';
        _diagFocusMarker.setPopupContent(popup);
      }
      if (!_diagUserPaused) _diagMap.panTo([lat, lon]);

      // Also refresh vehicle markers
      _diagDrawVehicles();
    })
    .catch(function () {
      var badge = document.getElementById('diagram-follow-badge');
      if (badge && _diagFollowTripId) {
        badge.innerHTML = '<span class="badge bg-secondary me-1">&#8212;</span>' +
          '<span class="d-none d-sm-inline text-muted small">Connection lost</span>';
      }
    });
}

function showVehicleMap(ds) {
  var label = ds.vehicleLabel || '';
  var tripId = ds.tripId || '';
  var lat = parseFloat(ds.lat);
  var lon = parseFloat(ds.lon);
  var headsign = ds.headsign || '';
  var stopName = ds.stopName || '';
  var minutesAway = ds.minutesAway || '';
  var departureDelay = ds.departureDelay !== '' ? ds.departureDelay : null;

  _diagStopFollow();
  _diagFocusStopId = null;
  _diagFollowTripId = tripId;
  _diagUserPaused = false;

  document.getElementById('stopMapModalLabel').textContent = label || 'Vehicle';
  // Hide stop link, show follow info
  document.getElementById('diagram-stop-link').style.display = 'none';
  var badge = document.getElementById('diagram-follow-badge');
  if (badge) badge.style.display = '';
  _diagUpdateFollowFooter(stopName, minutesAway, departureDelay);

  var modalEl = document.getElementById('stopMapModal');
  if (_diagMap && modalEl.classList.contains('show')) {
    _diagSetVehicleFocus(label, headsign, lat, lon, minutesAway, stopName);
    _diagFollowTimer = setInterval(function () { _diagFollowVehicle(tripId); }, 5000);
    return;
  }
  _diagInitModal(lat, lon, function () {
    _diagSetVehicleFocus(label, headsign, lat, lon, minutesAway, stopName);
    _diagFollowTimer = setInterval(function () { _diagFollowVehicle(tripId); }, 5000);
  });
}
