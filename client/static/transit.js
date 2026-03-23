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
      if (rt === 4) return 'directions_ferry';
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
    }
  };
}());
