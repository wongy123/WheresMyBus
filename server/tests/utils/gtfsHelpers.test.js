import { describe, it, expect, vi } from 'vitest';

// Mock all external dependencies so loading gtfsQueries.service.js does not
// attempt to connect to SQLite, Redis, or the GTFS-RT module.
vi.mock('gtfs', () => ({
  getStops: vi.fn(),
  getStopTimeUpdates: vi.fn(),
  openDb: vi.fn(),
}));

vi.mock('../../src/services/cache.service.js', () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheMGet: vi.fn(),
}));

vi.mock('../../src/services/gtfsRealtime.service.js', () => ({
  getLatestVehiclePositions: vi.fn(() => new Map()),
  getLatestTripUpdateCount: vi.fn(() => 0),
}));

vi.mock('../../src/utils/dbQuery.js', () => ({
  withDb: vi.fn(),
  defaultConfigPath: '../../config.json',
}));

import {
  hmsToSec,
  secToHms,
  haversineM,
  epochToLocalHms,
} from '../../src/services/gtfsQueries.service.js';

// ---------------------------------------------------------------------------
// hmsToSec
// ---------------------------------------------------------------------------
describe('hmsToSec', () => {
  it('converts HH:MM:SS to total seconds', () => {
    expect(hmsToSec('01:00:00')).toBe(3600);
    expect(hmsToSec('00:01:00')).toBe(60);
    expect(hmsToSec('00:00:01')).toBe(1);
    expect(hmsToSec('00:00:00')).toBe(0);
    expect(hmsToSec('10:30:45')).toBe(10 * 3600 + 30 * 60 + 45);
  });

  it('handles GTFS overflow times (> 24 h)', () => {
    expect(hmsToSec('25:00:00')).toBe(90000);
    expect(hmsToSec('24:00:00')).toBe(86400);
  });

  it('returns null for invalid or missing input', () => {
    expect(hmsToSec('')).toBeNull();
    expect(hmsToSec(null)).toBeNull();
    expect(hmsToSec(undefined)).toBeNull();
    expect(hmsToSec('invalid')).toBeNull();
    expect(hmsToSec('25:00')).toBeNull();   // wrong format (missing seconds)
    expect(hmsToSec('1:2:3')).toBeNull();   // requires zero-padded minutes/seconds
  });
});

// ---------------------------------------------------------------------------
// secToHms
// ---------------------------------------------------------------------------
describe('secToHms', () => {
  it('converts seconds to HH:MM:SS', () => {
    expect(secToHms(0)).toBe('00:00:00');
    expect(secToHms(60)).toBe('00:01:00');
    expect(secToHms(3600)).toBe('01:00:00');
    expect(secToHms(86399)).toBe('23:59:59');
  });

  it('wraps around midnight (86400 → 00:00:00)', () => {
    expect(secToHms(86400)).toBe('00:00:00');
  });

  it('returns null for invalid input', () => {
    expect(secToHms(null)).toBeNull();
    expect(secToHms(undefined)).toBeNull();
    expect(secToHms(NaN)).toBeNull();
  });

  it('round-trips with hmsToSec for normal times', () => {
    const times = ['00:00:00', '08:30:00', '12:45:15', '23:59:59'];
    for (const t of times) {
      expect(secToHms(hmsToSec(t))).toBe(t);
    }
  });
});

// ---------------------------------------------------------------------------
// haversineM
// ---------------------------------------------------------------------------
describe('haversineM', () => {
  it('returns 0 for identical coordinates', () => {
    expect(haversineM(-27.467, 153.028, -27.467, 153.028)).toBeCloseTo(0, 3);
  });

  it('is symmetric', () => {
    const a = haversineM(-27.467, 153.028, -27.490, 153.040);
    const b = haversineM(-27.490, 153.040, -27.467, 153.028);
    expect(a).toBeCloseTo(b, 5);
  });

  it('returns a positive distance for different coordinates', () => {
    const dist = haversineM(-27.4678, 153.0281, -27.4678, 153.0375);
    expect(dist).toBeGreaterThan(0);
    expect(dist).toBeLessThan(5000); // sanity check: < 5 km
  });

  it('returns ~111 km for 1 degree latitude difference at the equator', () => {
    const dist = haversineM(0, 0, 1, 0);
    // 1 degree latitude ≈ 111,195 m
    expect(dist).toBeGreaterThan(111_000);
    expect(dist).toBeLessThan(112_000);
  });
});

// ---------------------------------------------------------------------------
// epochToLocalHms  (uses GMT+10 offset by default)
// ---------------------------------------------------------------------------
describe('epochToLocalHms', () => {
  it('returns null for null input', () => {
    expect(epochToLocalHms(null)).toBeNull();
    expect(epochToLocalHms(undefined)).toBeNull();
  });

  it('converts epoch seconds to HH:MM:SS in GMT+10', () => {
    // 2024-04-06T00:00:00Z = 2024-04-06T10:00:00+10:00
    const midnightUtc = 1712361600;
    expect(epochToLocalHms(midnightUtc, 10)).toBe('10:00:00');
  });

  it('handles midnight UTC crossing correctly', () => {
    // 2024-04-06T14:00:00Z = 2024-04-07T00:00:00+10:00
    const twopmUtc = 1712361600 + 14 * 3600;
    expect(epochToLocalHms(twopmUtc, 10)).toBe('00:00:00');
  });
});
