// Shared helpers for timetable fragments.
// Loaded in <head> so they are available when HTMX swaps in partials.
(function (w) {
  // Return the best departure-time string from a row object.
  // Prefers estimated over scheduled, departure over arrival (for last-stop fallback).
  w.gtfsTime = function (row) {
    return row.estimated_departure_time || row.scheduled_departure_time ||
           row.estimated_arrival_time   || row.scheduled_arrival_time   || '';
  };

  // Return the effective delay in seconds from a row object.
  // Prefers departure_delay; falls back to arrival_delay (first/last stop).
  w.gtfsDelay = function (row) {
    return row.departure_delay != null ? row.departure_delay :
           row.arrival_delay   != null ? row.arrival_delay   : null;
  };

  // Format a GTFS HH:MM:SS time string for display, normalising overflow hours.
  w.formatGtfsTime = function (t) {
    if (!t) return '';
    var parts = String(t).split(':');
    if (parts.length < 2) return t;
    var h = parseInt(parts[0], 10) % 24;
    return (h < 10 ? '0' : '') + h + ':' + parts[1];
  };

  // Return { label, bg, fg } for a delay value in seconds (null = not yet known).
  w.delayInfo = function (seconds) {
    if (seconds === null || seconds === undefined) {
      return { label: 'Scheduled', bg: '#6c757d', fg: '#fff' };
    }
    var s = parseInt(seconds, 10);
    if (Math.abs(s) < 30) return { label: 'On time', bg: '#198754', fg: '#fff' };
    var mins = Math.floor(Math.abs(s) / 60);
    if (s > 0) return { label: mins + 'm late',  bg: '#ffc107', fg: '#000' };
    return            { label: mins + 'm early', bg: '#0dcaf0', fg: '#000' };
  };

  w.minsFromNow = function (hhmm) {
    var p = hhmm.split(':');
    var target = parseInt(p[0], 10) * 3600 + parseInt(p[1], 10) * 60;
    target = target % 86400; // normalize GTFS overflow hours (e.g. 24:50 → 00:50)
    var now = new Date();
    var nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    var diff = target - nowSec;
    if (diff < -3600) diff += 86400;
    return Math.round(diff / 60);
  };

  w.fmtMins = function (m) {
    if (m <= 0) return 'now';
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60), r = m % 60;
    return h + 'h' + (r ? ' ' + r + 'm' : '');
  };

  // Initialises popovers, time toggles, and RT icons in timetable fragments.
  // Called by the inline <script> at the bottom of each timetable partial.
  w.initTimetableFragment = function () {
    var _rtNow = Date.now();
    var rootStyle  = getComputedStyle(document.documentElement);
    var rtFresh    = rootStyle.getPropertyValue('--rt-color-fresh').trim()   || '#198754';
    var rtWarning  = rootStyle.getPropertyValue('--rt-color-warning').trim() || '#fd7e14';
    var rtStale    = rootStyle.getPropertyValue('--rt-color-stale').trim()   || '#dc3545';

    // Only one popover open at a time; dismiss on outside click
    var _activePop = null;
    function showExclusive(pop) {
      if (_activePop === pop) { pop.hide(); _activePop = null; return; }
      if (_activePop) _activePop.hide();
      pop.show();
      _activePop = pop;
    }
    document.addEventListener('click', function (e) {
      if (_activePop && !e.target.closest('.popover, .rt-icon, .gps-icon, .status-badge')) {
        _activePop.hide();
        _activePop = null;
      }
    }, true);

    document.querySelectorAll('.rt-icon').forEach(function (el) {
      var updatedAt = parseInt(el.dataset.updatedAt, 10);
      var ageSec = (updatedAt && !isNaN(updatedAt)) ? Math.round((_rtNow - updatedAt) / 1000) : null;
      var color, label;
      if (ageSec === null) {
        color = rtFresh; label = 'Real-time data';
      } else {
        label = ageSec < 60 ? 'Updated just now' : 'Updated ' + Math.round(ageSec / 60) + ' min ago';
        color = ageSec < 120 ? rtFresh : ageSec < 180 ? rtWarning : rtStale;
      }
      el.querySelector('.material-symbols-outlined').style.color = color;
      var pop = new bootstrap.Popover(el, { content: label, trigger: 'manual', placement: 'top' });
      el.addEventListener('click', function (e) { e.stopPropagation(); showExclusive(pop); });
    });

    var _gpsNow = Math.round(Date.now() / 1000);
    var gpsFresh   = '#0d6efd';
    var gpsWarning = '#fd7e14';
    var gpsStale   = '#dc3545';

    document.querySelectorAll('.gps-icon').forEach(function (el) {
      var ts = parseInt(el.dataset.vehicleTs, 10);
      var ageSec = (ts && !isNaN(ts)) ? (_gpsNow - ts) : null;
      var color, label;
      if (ageSec === null) {
        color = gpsFresh; label = 'GPS position';
      } else {
        label = ageSec < 60 ? 'GPS updated just now' : 'GPS updated ' + Math.round(ageSec / 60) + ' min ago';
        color = ageSec < 120 ? gpsFresh : ageSec < 300 ? gpsWarning : gpsStale;
      }
      el.querySelector('.material-symbols-outlined').style.color = color;
      var pop = new bootstrap.Popover(el, { content: label, trigger: 'manual', placement: 'top' });
      el.addEventListener('click', function (e) { e.stopPropagation(); showExclusive(pop); });
    });

    document.querySelectorAll('.status-badge').forEach(function (el) {
      var pop = new bootstrap.Popover(el, { trigger: 'manual', placement: 'top' });
      el.addEventListener('click', function (e) { e.stopPropagation(); showExclusive(pop); });
    });

    document.querySelectorAll('.tt-time').forEach(function (el) {
      var minEl = el.querySelector('.tt-min');
      var absEl = el.querySelector('.tt-abs');
      minEl.textContent = w.fmtMins(w.minsFromNow(el.dataset.time));
      el.addEventListener('click', function () {
        minEl.classList.toggle('d-none');
        absEl.classList.toggle('d-none');
      });
    });
  };
}(window));
