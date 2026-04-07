import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to create the mock functions with explicit implementations
const mockGet = vi.hoisted(() => vi.fn(() => Promise.resolve(null)));
const mockSet = vi.hoisted(() => vi.fn(() => Promise.resolve('OK')));
const mockMGet = vi.hoisted(() => vi.fn(() => Promise.resolve([])));

vi.mock('ioredis', () => ({
  default: vi.fn(function Redis() {
    this.get = mockGet;
    this.set = mockSet;
    this.mget = mockMGet;
    this.on = vi.fn();
  }),
}));

import { cacheGet, cacheSet, cacheMGet } from '../../src/services/cache.service.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// cacheGet
// ---------------------------------------------------------------------------
describe('cacheGet', () => {
  it('returns parsed JSON on a cache hit', async () => {
    mockGet.mockResolvedValue(JSON.stringify({ stop_id: '600028' }));

    const result = await cacheGet('rt:trip:abc');

    expect(result).toEqual({ stop_id: '600028' });
    expect(mockGet).toHaveBeenCalledWith('rt:trip:abc');
  });

  it('returns null on a cache miss', async () => {
    mockGet.mockResolvedValue(null);

    expect(await cacheGet('rt:trip:missing')).toBeNull();
  });

  it('returns null on a Redis connection error', async () => {
    mockGet.mockRejectedValue(new Error('ECONNREFUSED'));

    expect(await cacheGet('rt:trip:error')).toBeNull();
  });

  it('returns null for malformed JSON stored in Redis', async () => {
    mockGet.mockResolvedValue('{broken json');

    expect(await cacheGet('rt:trip:broken')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cacheSet
// ---------------------------------------------------------------------------
describe('cacheSet', () => {
  it('calls Redis SET with the correct key, JSON value, EX flag, and TTL', async () => {
    mockSet.mockResolvedValue('OK');
    const value = { tripId: 'trip1', stopUpdates: [] };

    await cacheSet('rt:trip:trip1', value, 300);

    expect(mockSet).toHaveBeenCalledWith(
      'rt:trip:trip1',
      JSON.stringify(value),
      'EX',
      300
    );
  });

  it('silently resolves even when Redis throws', async () => {
    mockSet.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(cacheSet('key', {}, 60)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// cacheMGet
// ---------------------------------------------------------------------------
describe('cacheMGet', () => {
  it('returns an empty array without calling Redis when given no keys', async () => {
    const result = await cacheMGet([]);

    expect(result).toEqual([]);
    expect(mockMGet).not.toHaveBeenCalled();
  });

  it('returns parsed values with null for misses', async () => {
    mockMGet.mockResolvedValue([
      JSON.stringify({ a: 1 }),
      null,
      JSON.stringify({ b: 2 }),
    ]);

    const result = await cacheMGet(['k1', 'k2', 'k3']);

    expect(result).toEqual([{ a: 1 }, null, { b: 2 }]);
  });

  it('returns an all-null array on Redis error', async () => {
    mockMGet.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await cacheMGet(['k1', 'k2']);

    expect(result).toEqual([null, null]);
  });
});