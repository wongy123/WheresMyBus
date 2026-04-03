// Maps the 2-char terminal codes used in Translink route short names to marketing line names.
// Each route short name is 4 chars: first 2 = origin terminal, last 2 = destination terminal.
// e.g. BNVL = Beenleigh (BN) to Varsity Lakes (VL) → Beenleigh Line + Gold Coast Line

const TERMINAL_LINE = {
  VL: 'Gold Coast Line',
  BD: 'Airport Line',
  CA: 'Caboolture Line',
  NA: 'Sunshine Coast Line',
  GY: 'Sunshine Coast Line',
  CL: 'Cleveland Line',
  DB: 'Doomben Line',
  FG: 'Ferny Grove Line',
  IP: 'Ipswich/Rosewood Line',
  RW: 'Ipswich/Rosewood Line',
  SH: 'Shorncliffe Line',
  SP: 'Springfield Line',
  RP: 'Redcliffe Peninsula Line',
  BN: 'Beenleigh Line',
};

// Exact short-name overrides for routes whose terminal codes don't map cleanly.
// BRBR is a Cleveland line circle service (Brisbane City loop via Cleveland).
const SHORT_NAME_OVERRIDE = {
  BRBR: ['Cleveland Line'],
};

export function getLineNames(shortName) {
  if (!shortName) return [];
  const upper = shortName.toUpperCase();
  if (SHORT_NAME_OVERRIDE[upper]) return SHORT_NAME_OVERRIDE[upper];
  if (upper.length < 4) return [];
  const origin = upper.slice(0, 2);
  const dest   = upper.slice(2, 4);
  const names  = new Set();
  if (TERMINAL_LINE[origin]) names.add(TERMINAL_LINE[origin]);
  if (TERMINAL_LINE[dest])   names.add(TERMINAL_LINE[dest]);
  return [...names];
}
