/* static/transit.js — shared transit type colour and icon helpers */
(function () {
  var cs = getComputedStyle(document.documentElement);
  function cssVar(name) { return cs.getPropertyValue(name).trim(); }

  /* Returns perceived brightness 0–1 for a hex colour like '#C4262E' */
  function _brightness(hex) {
    var h = hex.replace('#', '');
    var r = parseInt(h.substr(0, 2), 16) / 255;
    var g = parseInt(h.substr(2, 2), 16) / 255;
    var b = parseInt(h.substr(4, 2), 16) / 255;
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  window.TRANSIT = {
    /* Background colour for stop/station map markers */
    color: function (rt, isStation) {
      if (rt === 1 || rt === 2 || rt === 12)
        return isStation ? cssVar('--transit-rail-station')  : cssVar('--transit-rail-stop');
      if (rt === 0)
        return isStation ? cssVar('--transit-tram-station')  : cssVar('--transit-tram-stop');
      if (rt === 4)
        return isStation ? cssVar('--transit-ferry-station') : cssVar('--transit-ferry-stop');
      return   isStation ? cssVar('--transit-bus-station')   : cssVar('--transit-bus-stop');
    },
    /* Brand colour for vehicle markers and CSS text classes */
    vehicleColor: function (rt) {
      if (rt === 1 || rt === 2 || rt === 12) return cssVar('--transit-rail-color');
      if (rt === 0)  return cssVar('--transit-tram-color');
      if (rt === 4)  return cssVar('--transit-ferry-color');
      return cssVar('--transit-bus-color');
    },
    label: function (rt) {
      if (rt === 1 || rt === 2 || rt === 12) return 'T';
      if (rt === 0) return 'L';
      if (rt === 4) return 'F';
      return 'B';
    },
    vehicleIcon: function (rt) {
      if (rt === 1 || rt === 2 || rt === 12) return 'train';
      if (rt === 0) return 'tram';
      if (rt === 4) return 'directions_boat';
      return 'directions_bus';
    },
    makeStopIcon: function (s) {
      var rt        = s.primary_route_type;
      var isStation = s.location_type === 1;
      var color     = window.TRANSIT.color(rt, isStation);
      var label     = window.TRANSIT.label(rt);
      var textColor = _brightness(color) > 0.55 ? '#333333' : 'white';
      var size      = isStation ? 22 : 18;
      var radius    = isStation ? '4px' : '50%';
      return L.divIcon({
        className: '',
        html: '<div style="width:' + size + 'px;height:' + size + 'px;background:' + color +
              ';border-radius:' + radius + ';border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,.45);' +
              'display:flex;align-items:center;justify-content:center;' +
              'color:' + textColor + ';font-weight:700;font-size:10px;font-family:sans-serif;">' + label + '</div>',
        iconSize: [size, size], iconAnchor: [size / 2, size / 2]
      });
    },
    // Build a vehicle popup for stop-context maps (stop detail page, main map sidebar).
    // Shows route name, label, headsign, optional next stop + ETA, and a "View route" link.
    // opts: { routeShortName, label, headsign, stopName, etaStr, routeId, basePath }
    stopVehiclePopup: function (opts) {
      var label = opts.label ? ' · ' + opts.label : '';
      var meta = opts.stopName
        ? 'Next: ' + opts.stopName + (opts.etaStr ? ' · ' + opts.etaStr : '')
        : (opts.etaStr || '');
      return '<b>' + (opts.routeShortName || '') + '</b>' + label +
        (opts.headsign ? ' — ' + opts.headsign : '') +
        (meta ? '<br><span class="map-popup-meta">' + meta + '</span>' : '') +
        (opts.routeId
          ? '<br><a href="' + (opts.basePath || '') + '/routes/' + encodeURIComponent(opts.routeId) + '" class="map-popup-link">View route</a>'
          : '');
    },
    // Build a vehicle popup for route-context maps (route diagram / details page).
    // Shows headsign, label, and next stop with ETA.
    // opts: { headsign, label, stopName, etaStr }
    routeVehiclePopup: function (opts) {
      var label = opts.label ? ' · ' + opts.label : '';
      return '<b>' + (opts.headsign || 'Service') + '</b>' + label +
        (opts.stopName
          ? '<br><span class="map-popup-meta">Next: ' + opts.stopName + (opts.etaStr ? ' · ' + opts.etaStr : '') + '</span>'
          : '');
    },
    makeVehicleIcon: function (color, iconName) {
      return L.divIcon({
        className: '',
        html: '<div style="width:28px;height:28px;background:' + color + ';border-radius:50%;' +
              'border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,.5);' +
              'display:flex;align-items:center;justify-content:center;">' +
              '<span class="material-symbols-outlined" style="font-size:.95rem;color:white;line-height:1;">' +
              iconName + '</span></div>',
        iconSize: [28, 28], iconAnchor: [14, 14]
      });
    },
    // Build a stop marker popup: bold stop name + "View Stop" link.
    // s: object with stop_name and stop_id. basePath: app base path string.
    makeStopPopup: function (s, basePath) {
      return '<b>' + s.stop_name + '</b>' +
        '<br><a href="' + basePath + '/stops/' + s.stop_id + '" class="map-popup-link">View Stop</a>';
    },
    // Create a route stop dot divIcon.
    // color: css color string for the border. size: diameter in px (default 12).
    makeRouteDot: function (color, size) {
      size = size || 12;
      return L.divIcon({
        className: '',
        html: '<div style="width:' + size + 'px;height:' + size + 'px;background:#fff;border-radius:50%;' +
              'border:3px solid ' + color + ';box-shadow:0 1px 4px rgba(0,0,0,.35);"></div>',
        iconSize: [size, size], iconAnchor: [size / 2, size / 2]
      });
    },
    // Synchronise a map's vehicle markers with a fresh vehicles array.
    // theMap:    Leaflet map instance
    // markerMap: { [trip_id]: L.Marker } — mutated in place (add/update/remove)
    // vehicles:  array with .trip_id, .lat, .lon
    // opts: {
    //   makePopup:   function(v) → html string
    //   getColor:    function(v) → css color  (new markers only; default: vehicleColor(3))
    //   getIconName: function(v) → icon name  (new markers only; default: vehicleIcon(3))
    //   onNewMarker: function(marker, v)       (optional, called after marker added)
    // }
    // Attach a fullscreen toggle button (top-right overlay) to a map container.
    // container: element or id string. getMap: function returning the Leaflet map.
    addFullscreenBtn: function (container, getMap) {
      if (typeof container === 'string') container = document.getElementById(container);
      if (!container) return;
      var _origHeight = '';
      var btn = document.createElement('button');
      btn.className = 'btn btn-sm btn-light border shadow-sm d-flex align-items-center';
      btn.style.cssText = 'position:absolute;z-index:1001;top:8px;right:8px;pointer-events:auto;padding:3px 6px;';
      btn.title = 'Toggle fullscreen';
      var icon = document.createElement('span');
      icon.className = 'material-symbols-outlined';
      icon.style.cssText = 'font-size:.9rem;line-height:1;';
      icon.textContent = 'fullscreen';
      btn.appendChild(icon);
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (document.fullscreenElement) { document.exitFullscreen(); }
        else { container.requestFullscreen(); }
      });
      container.addEventListener('fullscreenchange', function () {
        var isFs = document.fullscreenElement === container;
        icon.textContent = isFs ? 'fullscreen_exit' : 'fullscreen';
        if (isFs) { _origHeight = container.style.height; container.style.height = '100%'; }
        else { container.style.height = _origHeight; }
        var m = typeof getMap === 'function' ? getMap() : getMap;
        if (m) setTimeout(function () { m.invalidateSize(); }, 50);
      });
      container.appendChild(btn);
    },
    updateVehicleMarkers: function (theMap, markerMap, vehicles, opts) {
      var seen = {};
      vehicles.forEach(function (v) {
        if (!v.lat || !v.lon) return;
        seen[v.trip_id] = true;
        var popup = opts.makePopup(v);
        if (markerMap[v.trip_id]) {
          markerMap[v.trip_id].setLatLng([v.lat, v.lon]);
          markerMap[v.trip_id].setPopupContent(popup);
        } else {
          var color    = opts.getColor    ? opts.getColor(v)    : window.TRANSIT.vehicleColor(3);
          var iconName = opts.getIconName ? opts.getIconName(v) : window.TRANSIT.vehicleIcon(3);
          var marker = L.marker([v.lat, v.lon], {
            icon: window.TRANSIT.makeVehicleIcon(color, iconName),
            zIndexOffset: 1000
          }).addTo(theMap).bindPopup(popup);
          if (opts.onNewMarker) opts.onNewMarker(marker, v);
          markerMap[v.trip_id] = marker;
        }
      });
      Object.keys(markerMap).forEach(function (tid) {
        if (!seen[tid]) { theMap.removeLayer(markerMap[tid]); delete markerMap[tid]; }
      });
    }
  };
}());
