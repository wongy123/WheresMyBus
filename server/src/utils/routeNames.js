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

export function getLineNames(shortName) {
  if (!shortName || shortName.length < 4) return [];
  const origin = shortName.slice(0, 2).toUpperCase();
  const dest   = shortName.slice(2, 4).toUpperCase();
  const names  = new Set();
  if (TERMINAL_LINE[origin]) names.add(TERMINAL_LINE[origin]);
  if (TERMINAL_LINE[dest])   names.add(TERMINAL_LINE[dest]);
  return [...names];
}
