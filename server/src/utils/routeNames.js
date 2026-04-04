// Maps the 2-char terminal codes used in Translink route short names to marketing line names.
// Each route short name is 4 chars: first 2 = origin terminal, last 2 = destination terminal.
// Terminal codes confirmed from official Translink All Train Timetables route code table.
//
// Known terminal codes:
//   BR=Brisbane(city), BN=Beenleigh, VL=Varsity Lakes(Gold Coast), CA=Caboolture,
//   BD=Bowen Hills/Domestic(Doomben/Caboolture junction area), CL=Cleveland,
//   DB=Doomben, FG=Ferny Grove, IP=Ipswich, RW=Rosewood, SH=Shorncliffe,
//   SP=Springfield, RP=Redcliffe Peninsula(Kippa-Ring), NA=Nambour, GY=Gympie

const TERMINAL_LINE = {
  VL: 'Gold Coast Line',
  BN: 'Beenleigh Line',   // Beenleigh Line is separate; BNVL/VLBN appear under both BN and VL lines
  BD: 'Doomben Line',     // BD (junction area) appears in Doomben Line (BDCA) and Caboolture Line (CABD)
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
};

// Exact short-name overrides for routes whose terminal codes don't map cleanly.
// Source: official Translink All Train Timetables route code table.
//   Airport Line: BRBR (Brisbane airport loop), CLBR (Cleveland→Brisbane via Airport)
//   CLBR also appears under Cleveland Line, so it gets both.
const SHORT_NAME_OVERRIDE = {
  BRBR: ['Airport Line'],
  CLBR: ['Airport Line', 'Cleveland Line'],
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

// "Gold Coast Line" → "gold-coast-line", "Ipswich/Rosewood Line" → "ipswich-rosewood-line"
export function slugifyLineName(lineName) {
  return lineName
    .toLowerCase()
    .replace(/\//g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

// Build reverse map: slug → original line name
const SLUG_TO_LINE = {};
for (const name of new Set(Object.values(TERMINAL_LINE))) {
  SLUG_TO_LINE[slugifyLineName(name)] = name;
}
for (const names of Object.values(SHORT_NAME_OVERRIDE)) {
  for (const name of names) {
    SLUG_TO_LINE[slugifyLineName(name)] = name;
  }
}

// "gold-coast-line" → "Gold Coast Line", unknown slug → null
export function getLineNameFromSlug(slug) {
  return SLUG_TO_LINE[slug] ?? null;
}

// "Gold Coast Line" → ["VL"], "Sunshine Coast Line" → ["NA", "GY"]
export function getTerminalCodesForLine(lineName) {
  return Object.entries(TERMINAL_LINE)
    .filter(([, name]) => name === lineName)
    .map(([code]) => code);
}

// "Cleveland Line" → ["BRBR"] (route_short_name overrides for this line)
export function getShortNameOverridesForLine(lineName) {
  return Object.entries(SHORT_NAME_OVERRIDE)
    .filter(([, names]) => names.includes(lineName))
    .map(([shortName]) => shortName);
}
