/**
 * Parse a query parameter as an integer, returning defaultVal if invalid.
 */
export function parseIntParam(val, defaultVal = undefined) {
  const parsed = Number.parseInt(val, 10);
  return Number.isFinite(parsed) ? parsed : defaultVal;
}

/**
 * Parse a direction query param — returns 0 or 1, or defaultVal if invalid.
 */
export function parseDirection(val, defaultVal = 0) {
  const d = Number.parseInt(val, 10);
  return d === 0 || d === 1 ? d : defaultVal;
}
