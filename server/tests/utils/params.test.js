import { describe, it, expect } from 'vitest';
import { parseIntParam, parseDirection } from '../../src/utils/params.js';

describe('parseIntParam', () => {
  it('parses a valid integer string', () => {
    expect(parseIntParam('42')).toBe(42);
  });

  it('parses "0"', () => {
    expect(parseIntParam('0')).toBe(0);
  });

  it('parses a negative integer string', () => {
    expect(parseIntParam('-5')).toBe(-5);
  });

  it('returns undefined for non-numeric string', () => {
    expect(parseIntParam('foo')).toBeUndefined();
  });

  it('returns provided defaultVal for non-numeric string', () => {
    expect(parseIntParam('foo', 10)).toBe(10);
  });

  it('returns undefined for undefined input', () => {
    expect(parseIntParam(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parseIntParam('')).toBeUndefined();
  });

  it('truncates floats to integer', () => {
    expect(parseIntParam('3.9')).toBe(3);
  });
});

describe('parseDirection', () => {
  it('returns 0 for "0"', () => {
    expect(parseDirection('0')).toBe(0);
  });

  it('returns 1 for "1"', () => {
    expect(parseDirection('1')).toBe(1);
  });

  it('returns default 0 for invalid value', () => {
    expect(parseDirection('2')).toBe(0);
    expect(parseDirection('foo')).toBe(0);
    expect(parseDirection(undefined)).toBe(0);
  });

  it('returns custom default for invalid value', () => {
    expect(parseDirection('99', 1)).toBe(1);
  });

  it('returns 0 even when passed as integer 0', () => {
    expect(parseDirection(0)).toBe(0);
  });
});
