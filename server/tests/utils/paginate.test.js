import { describe, it, expect, vi } from 'vitest';
import { paginateResponse } from '../../src/utils/paginate.js';

function makeReq(query = {}) {
  return { query, baseUrl: '/api', path: '/test' };
}

function makeRes() {
  const headers = {};
  return {
    set: vi.fn((k, v) => { headers[k] = v; }),
    _headers: headers,
  };
}

describe('paginateResponse', () => {
  it('returns first page with default limit', () => {
    const data = Array.from({ length: 50 }, (_, i) => i);
    const result = paginateResponse({ data, req: makeReq(), res: null, defaultLimit: 20 });

    expect(result.data).toHaveLength(20);
    expect(result.data[0]).toBe(0);
    expect(result.pagination.page).toBe(1);
    expect(result.pagination.total).toBe(50);
    expect(result.pagination.pageCount).toBe(3);
    expect(result.pagination.hasNext).toBe(true);
    expect(result.pagination.hasPrev).toBe(false);
  });

  it('returns correct slice for page 2', () => {
    const data = Array.from({ length: 50 }, (_, i) => i);
    const result = paginateResponse({ data, req: makeReq({ page: '2', limit: '10' }), res: null });

    expect(result.data).toHaveLength(10);
    expect(result.data[0]).toBe(10);
    expect(result.pagination.hasPrev).toBe(true);
    expect(result.pagination.hasNext).toBe(true);
  });

  it('returns empty slice for out-of-range page', () => {
    const data = [1, 2, 3];
    const result = paginateResponse({ data, req: makeReq({ page: '99' }), res: null });

    expect(result.data).toHaveLength(0);
  });

  it('handles empty data array', () => {
    const result = paginateResponse({ data: [], req: makeReq(), res: null });

    expect(result.data).toHaveLength(0);
    expect(result.pagination.total).toBe(0);
    expect(result.pagination.pageCount).toBe(0);
    expect(result.pagination.hasNext).toBe(false);
    expect(result.pagination.hasPrev).toBe(false);
  });

  it('clamps limit to maxLimit', () => {
    const data = Array.from({ length: 200 }, (_, i) => i);
    const result = paginateResponse({ data, req: makeReq({ limit: '999' }), res: null, maxLimit: 50 });

    expect(result.data).toHaveLength(50);
  });

  it('sets X-Total-Count header when res is provided', () => {
    const res = makeRes();
    paginateResponse({ data: [1, 2, 3], req: makeReq(), res });

    expect(res.set).toHaveBeenCalledWith('X-Total-Count', '3');
  });

  it('sets Link header with next/prev/first/last when res is provided', () => {
    const data = Array.from({ length: 30 }, (_, i) => i);
    const res = makeRes();
    paginateResponse({ data, req: makeReq({ page: '2', limit: '10' }), res });

    const linkCall = res.set.mock.calls.find(([k]) => k === 'Link');
    expect(linkCall).toBeDefined();
    const linkHeader = linkCall[1];
    expect(linkHeader).toContain('rel="next"');
    expect(linkHeader).toContain('rel="prev"');
  });

  it('does not set Link header when res is null', () => {
    const result = paginateResponse({ data: [1, 2, 3], req: makeReq(), res: null });
    expect(result).toBeDefined();
  });

  it('returns links object', () => {
    const data = Array.from({ length: 30 }, (_, i) => i);
    const result = paginateResponse({ data, req: makeReq({ page: '2', limit: '10' }), res: null });

    expect(result.links.next).toContain('page=3');
    expect(result.links.prev).toContain('page=1');
    expect(result.links.first).toContain('page=1');
    expect(result.links.last).toContain('page=3');
  });
});
