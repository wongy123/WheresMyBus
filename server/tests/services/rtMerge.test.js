/**
 * Tests for the real-time merge layer in gtfsQueries.service.js:
 *   - applyRealtimeToRow  — merges RT delay / vehicle-position data into a timetable row
 *   - effectiveRowSec     — computes the sort-time for a row (with midnight-rollover logic)
 *
 * Both are pure functions: no I/O, no mocking beyond the module load-time deps.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('gtfs', () => ({
  getStops: vi.fn(),
  getStopTimeUpdates: vi.fn(),
  openDb: vi.fn(),
}));

vi.mock('../../src/services/cache.service.js', () => ({
  cacheGet:  vi.fn(),
  cacheSet:  vi.fn(),
  cacheMGet: vi.fn(),
}));

vi.mock('../../src/services/gtfsRealtime.service.js', () => ({
  getLatestVehiclePositions: vi.fn(() => new Map()),
  getLatestTripUpdateCount:  vi.fn(() => 0),
}));

vi.mock('../../src/utils/dbQuery.js', () => ({
  withDb: vi.fn(),
  defaultConfigPath: '../../config.json',
}));

import { applyRealtimeToRow, effectiveRowSec } from '../../src/services/gtfsQueries.service.js';

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

/** A minimal timetable row — the same shape the SQL queries produce. */
const BASE_ROW = Object.freeze({
  trip_id: 'TRIP_001',
  stop_id: '600028',
  stop_sequence: 5,
  scheduled_departure_time: '09:00:00',
  scheduled_arrival_time: '08:59:30',
  route_short_name: '66',
  route_type: 3,
  direction_id: 0,
});

/** Build an RT cache entry (what Redis stores for rt:trip:* keys). */
function makeRt(stopUpdates = [], overrides = {}) {
  return {
    tripId: 'TRIP_001',
    updatedAt: 1712361600000,   // 2024-04-06T00:00:00Z as epoch-ms → local '10:00:00'
    stopUpdates,
    ...overrides,
  };
}

/** Build a stop-time update entry inside an RT cache value. */
function makeSu(overrides = {}) {
  return {
    stopSequence:   5,
    stopId:         '600028',
    arrivalDelay:   null,
    departureDelay: null,
    arrivalTime:    null,
    departureTime:  null,
    ...overrides,
  };
}

/** A vehicle-position cache entry (what Redis stores for rt:vpos:* keys). */
const BASE_VPOS = Object.freeze({
  latitude:             -27.467,
  longitude:            153.028,
  vehicleId:            'V001',
  vehicleLabel:         'Bus 001',
  currentStopSequence:  3,
  timestamp:            1712345670,  // 2024-04-05T19:34:30Z → GMT+10 = '05:34:30'
});

// ---------------------------------------------------------------------------
// applyRealtimeToRow
// ---------------------------------------------------------------------------
describe('applyRealtimeToRow', () => {

  // ── no data ────────────────────────────────────────────────────────────────

  it('returns the exact same row reference when rt and vpos are both null', () => {
    const row = { ...BASE_ROW };
    expect(applyRealtimeToRow(row, null, null)).toBe(row);
  });

  // ── vpos only ──────────────────────────────────────────────────────────────

  it('vpos only: populates all GPS fields on the enriched row', () => {
    const result = applyRealtimeToRow(BASE_ROW, null, BASE_VPOS);

    expect(result.vehicle_latitude).toBeCloseTo(-27.467);
    expect(result.vehicle_longitude).toBeCloseTo(153.028);
    expect(result.vehicle_id).toBe('V001');
    expect(result.vehicle_label).toBe('Bus 001');
    expect(result.vehicle_current_stop_sequence).toBe(3);
    expect(result.vehicle_timestamp).toBe(1712345670);
    expect(result.vehicle_time_local).toBe('05:34:30');
  });

  it('vpos only: sets real_time_data=1 and has_gps=1, leaves has_rt unset', () => {
    const result = applyRealtimeToRow(BASE_ROW, null, BASE_VPOS);

    expect(result.real_time_data).toBe(1);
    expect(result.has_gps).toBe(1);
    expect(result.has_rt).toBeUndefined();
  });

  it('vpos only: does not mutate the original row', () => {
    const row = { ...BASE_ROW };
    applyRealtimeToRow(row, null, BASE_VPOS);

    expect(row.vehicle_id).toBeUndefined();
  });

  // ── RT delay: exact stop_sequence match ───────────────────────────────────

  it('exact seq match: applies departureDelay to scheduled departure time', () => {
    // 09:00:00 + 120 s = 09:02:00
    const rt = makeRt([makeSu({ departureDelay: 120 })]);
    const result = applyRealtimeToRow(BASE_ROW, rt, null);

    expect(result.estimated_departure_time).toBe('09:02:00');
    expect(result.departure_delay).toBe(120);
    expect(result.has_rt).toBe(1);
    expect(result.real_time_data).toBe(1);
    expect(result.has_gps).toBeUndefined();
  });

  it('exact seq match: applies arrivalDelay to scheduled arrival time', () => {
    // 08:59:30 + 90 s = 09:01:00
    const rt = makeRt([makeSu({ arrivalDelay: 90 })]);
    const result = applyRealtimeToRow(BASE_ROW, rt, null);

    expect(result.estimated_arrival_time).toBe('09:01:00');
    expect(result.arrival_delay).toBe(90);
  });

  it('exact seq match: handles a negative delay (early service)', () => {
    // 09:00:00 − 120 s = 08:58:00
    const rt = makeRt([makeSu({ departureDelay: -120 })]);
    const result = applyRealtimeToRow(BASE_ROW, rt, null);

    expect(result.estimated_departure_time).toBe('08:58:00');
    expect(result.departure_delay).toBe(-120);
  });

  // ── RT absolute timestamps ─────────────────────────────────────────────────

  it('exact match: uses absolute departureTime when no departureDelay is present', () => {
    // 1712361600 = 2024-04-06T00:00:00Z → epochToHms(GMT+10) = '10:00:00'
    const rt = makeRt([makeSu({ departureTime: 1712361600, departureDelay: null })]);
    const result = applyRealtimeToRow(BASE_ROW, rt, null);

    expect(result.estimated_departure_time).toBe('10:00:00');
    expect(result.has_rt).toBe(1);
  });

  it('exact match: uses absolute arrivalTime when no arrivalDelay is present', () => {
    const rt = makeRt([makeSu({ arrivalTime: 1712361600, arrivalDelay: null })]);
    const result = applyRealtimeToRow(BASE_ROW, rt, null);

    expect(result.estimated_arrival_time).toBe('10:00:00');
  });

  // ── fallback: stop_id match ────────────────────────────────────────────────

  it('stop_id match: applies delay when stop_sequence does not match', () => {
    // RT entry has a different sequence but the same stop_id — should still match.
    const rt = makeRt([makeSu({ stopSequence: 99, stopId: '600028', departureDelay: 180 })]);
    const result = applyRealtimeToRow(BASE_ROW, rt, null);

    expect(result.estimated_departure_time).toBe('09:03:00');
    expect(result.departure_delay).toBe(180);
  });

  // ── preceding stop propagation ─────────────────────────────────────────────

  it('preceding stop: delay IS propagated to later stops', () => {
    // RT only has an update at stop 3 (< row stop 5); delay should be carried forward.
    const rt = makeRt([
      makeSu({ stopSequence: 3, stopId: 'OTHER', departureDelay: 120, arrivalDelay: 60 }),
    ]);
    const result = applyRealtimeToRow(BASE_ROW, rt, null);

    // 09:00:00 + 120 s = 09:02:00
    expect(result.estimated_departure_time).toBe('09:02:00');
    expect(result.departure_delay).toBe(120);
    // 08:59:30 + 60 s = 09:00:30
    expect(result.estimated_arrival_time).toBe('09:00:30');
    expect(result.arrival_delay).toBe(60);
    expect(result.has_rt).toBe(1);
  });

  it('preceding stop: absolute timestamp is NOT applied (would belong to the wrong stop)', () => {
    // RT entry at stop 3 has an absolute departureTime but no delay.
    // suIsPreceding=true must prevent this timestamp being used for stop 5.
    const rt = makeRt([
      makeSu({ stopSequence: 3, stopId: 'OTHER', departureTime: 1712361600, departureDelay: null }),
    ]);
    const result = applyRealtimeToRow(BASE_ROW, rt, null);

    // estimated_departure_time must NOT be set from the preceding stop's absolute time
    expect(result.estimated_departure_time).toBeUndefined();
    expect(result.has_rt).toBeUndefined();
    expect(result.real_time_data).toBeUndefined();
  });

  it('preceding stop: picks the closest preceding stop when multiple precede', () => {
    // Stops 2, 3, 4 all precede stop 5; stop 4 should be used (closest).
    const rt = makeRt([
      makeSu({ stopSequence: 2, stopId: 'S2', departureDelay: 60 }),
      makeSu({ stopSequence: 4, stopId: 'S4', departureDelay: 240 }),  // closest
      makeSu({ stopSequence: 3, stopId: 'S3', departureDelay: 120 }),
    ]);
    const result = applyRealtimeToRow(BASE_ROW, rt, null);

    // 09:00:00 + 240 s = 09:04:00
    expect(result.estimated_departure_time).toBe('09:04:00');
  });

  // ── no matching stop update ────────────────────────────────────────────────

  it('no matching stop update: real_time_data and has_rt are not set', () => {
    // RT has an update only at a later stop (seq=6), nothing preceding stop 5.
    const rt = makeRt([
      makeSu({ stopSequence: 6, stopId: 'LATER', departureDelay: 60 }),
    ]);
    const result = applyRealtimeToRow(BASE_ROW, rt, null);

    expect(result.real_time_data).toBeUndefined();
    expect(result.has_rt).toBeUndefined();
  });

  it('no matching stop update: realtime_updated_at and rt_min_stop_sequence are still set', () => {
    const rt = makeRt([makeSu({ stopSequence: 6, stopId: 'LATER', departureDelay: 60 })]);
    const result = applyRealtimeToRow(BASE_ROW, rt, null);

    expect(result.realtime_updated_at).toBe(1712361600000);
    expect(result.realtime_updated_local).toBe('10:00:00');
    expect(result.rt_min_stop_sequence).toBe(6);
  });

  // ── rt_min_stop_sequence ───────────────────────────────────────────────────

  it('rt_min_stop_sequence is the minimum positive, finite sequence across all stop updates', () => {
    const rt = makeRt([
      makeSu({ stopSequence: 5,    departureDelay: 60 }),
      makeSu({ stopSequence: 3,    departureDelay: 30 }),
      makeSu({ stopSequence: 8,    departureDelay: 90 }),
      makeSu({ stopSequence: null, departureDelay: 10 }),  // null → filtered
      makeSu({ stopSequence: 0,    departureDelay: 10 }),  // zero → filtered
    ]);
    const result = applyRealtimeToRow(BASE_ROW, rt, null);

    expect(result.rt_min_stop_sequence).toBe(3);
  });

  // ── RT + vpos combined ────────────────────────────────────────────────────

  it('RT + vpos: sets real_time_data=1, has_rt=1, and has_gps=1', () => {
    const rt     = makeRt([makeSu({ departureDelay: 60 })]);
    const result = applyRealtimeToRow(BASE_ROW, rt, BASE_VPOS);

    expect(result.real_time_data).toBe(1);
    expect(result.has_rt).toBe(1);
    expect(result.has_gps).toBe(1);
    // Both delay and GPS fields present
    expect(result.departure_delay).toBe(60);
    expect(result.vehicle_id).toBe('V001');
  });

  // ── immutability ─────────────────────────────────────────────────────────

  it('always returns a new object — never mutates the original row', () => {
    const row    = { ...BASE_ROW };
    const rt     = makeRt([makeSu({ departureDelay: 60 })]);
    const result = applyRealtimeToRow(row, rt, null);

    expect(result).not.toBe(row);
    expect(row.estimated_departure_time).toBeUndefined();
    expect(row.has_rt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// effectiveRowSec
// ---------------------------------------------------------------------------
describe('effectiveRowSec', () => {

  it('prefers estimated_departure_time over all other fields', () => {
    const row = {
      win_sec: 32000,
      estimated_departure_time:  '09:00:00',  // → 32400
      estimated_arrival_time:    '08:59:00',
      scheduled_departure_time:  '08:55:00',
      scheduled_arrival_time:    '08:54:00',
    };
    expect(effectiveRowSec(row)).toBe(32400);
  });

  it('falls back to estimated_arrival_time when no estimated departure', () => {
    const row = {
      estimated_arrival_time:   '09:01:00',   // → 32460
      scheduled_departure_time: '08:55:00',
      scheduled_arrival_time:   '08:54:00',
    };
    expect(effectiveRowSec(row)).toBe(32460);
  });

  it('falls back to scheduled_departure_time when no estimated times', () => {
    const row = {
      scheduled_departure_time: '09:05:00',   // → 32700
      scheduled_arrival_time:   '09:04:00',
    };
    expect(effectiveRowSec(row)).toBe(32700);
  });

  it('falls back to scheduled_arrival_time as last resort', () => {
    const row = { scheduled_arrival_time: '09:04:30' };  // → 32670
    expect(effectiveRowSec(row)).toBe(32670);
  });

  it('falls back to win_sec when no time fields are present', () => {
    const row = { win_sec: 34000 };
    expect(effectiveRowSec(row)).toBe(34000);
  });

  it('returns null for an empty row', () => {
    expect(effectiveRowSec({})).toBeNull();
    expect(effectiveRowSec(null)).toBeNull();
  });

  it('midnight rollover: adds 86400 when estimated time is > 12 h behind the window', () => {
    // Window opened at 23:53:20 (win_sec=86000).
    // Service is at 00:30:00 next day (sec=1800).
    // 86000 - 1800 = 84200 > 43200 → sec += 86400 → 88200
    const row = {
      win_sec: 86000,
      scheduled_departure_time: '00:30:00',
    };
    expect(effectiveRowSec(row)).toBe(1800 + 86400);
  });

  it('no rollover when the time gap is 12 h or less', () => {
    // win_sec=32400 (09:00), scheduled=21:00 (75600).  75600 − 32400 = −43200 (negative) → no rollover.
    // Or: win_sec=0, scheduled='11:00:00' (39600). 0 − 39600 < 0 → no rollover.
    const row = { win_sec: 32400, scheduled_departure_time: '21:00:00' };
    // 32400 − 75600 = −43200, not > 43200 → no rollover
    expect(effectiveRowSec(row)).toBe(75600);
  });
});
