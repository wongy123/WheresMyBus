/**
 * Returns display info for a delay value (in seconds).
 * null  → scheduled (gray)
 * 0     → on time (green)
 * > 0   → N min late (yellow)
 * < 0   → N min early (blue)
 */
export function delayInfo(seconds) {
  if (seconds === null || seconds === undefined) {
    return { status: 'scheduled', label: 'Scheduled' };
  }
  if (seconds === 0) {
    return { status: 'ontime', label: 'On time' };
  }
  const mins = Math.round(Math.abs(seconds) / 60);
  if (seconds > 0) {
    return { status: 'late', label: `${mins} min late` };
  }
  return { status: 'early', label: `${mins} min early` };
}
