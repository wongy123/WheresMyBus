// Shared helpers for timetable fragments.
// Loaded in <head> so they are available when HTMX swaps in partials.
(function (w) {
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
      new bootstrap.Popover(el, { content: label, trigger: 'focus', placement: 'top' });
    });

    document.querySelectorAll('.status-badge').forEach(function (el) {
      new bootstrap.Popover(el, { trigger: 'focus', placement: 'top' });
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
