import type { Criticality, TimelineType, WorkflowState } from '@canopy/contracts';

/** Reference values the importer recognises. Keys are matched after lower-casing and collapsing whitespace. */

export interface EnumTable<T extends string> {
  /** Lower-case key → value. */
  byKey: Record<string, T>;
  /** Spellings that need no normalisation issue. */
  canonical: readonly string[];
}

export const CRITICALITY: EnumTable<Criticality> = {
  byKey: {
    'super critical': 'SUPER_CRITICAL',
    critical: 'CRITICAL',
    high: 'HIGH',
    medium: 'MEDIUM',
    low: 'LOW',
  },
  canonical: ['Super Critical', 'Critical', 'High', 'Medium', 'Low'],
};

export const TIMELINE: EnumTable<TimelineType> = {
  byKey: { 'time based': 'TIME_BASED', 'on going': 'ONGOING', ongoing: 'ONGOING' },
  canonical: ['Time Based', 'On Going', 'Ongoing'],
};

/** Register status → workflow state (packages/importer/CLAUDE.md "Status"). */
export const STATUS: EnumTable<'APPROVED' | 'OPEN' | 'NOT_APPLICABLE'> = {
  byKey: { complied: 'APPROVED', pending: 'OPEN', 'not applicable': 'NOT_APPLICABLE' },
  canonical: ['Complied', 'Pending', 'Not Applicable'],
} satisfies EnumTable<WorkflowState>;

export function enumKey(value: string): string {
  return value
    .trim()
    .replace(/[\s_]+/g, ' ')
    .toLowerCase();
}

/** Form and Log Sheet values that mean "none". */
export const NULL_PLACEHOLDERS = new Set(['na', 'n/a', 'n.a.', '-', '--', 'nil', 'none']);

/** Looks like an attachment name ("Schedule.docx"), which becomes a template flagged "file not attached". */
export function looksLikeFileName(value: string): boolean {
  return /\.(docx?|xlsx?|xlsm|pdf|csv|pptx?|txt|odt|ods|jpe?g|png)$/i.test(value.trim());
}

/** ISO 3166-2:IN state and union territory codes, with older codes still seen in registers. */
export const INDIAN_STATES: Record<string, string> = {
  AN: 'Andaman and Nicobar Islands',
  AP: 'Andhra Pradesh',
  AR: 'Arunachal Pradesh',
  AS: 'Assam',
  BR: 'Bihar',
  CH: 'Chandigarh',
  CT: 'Chhattisgarh',
  DH: 'Dadra and Nagar Haveli and Daman and Diu',
  DL: 'Delhi',
  GA: 'Goa',
  GJ: 'Gujarat',
  HP: 'Himachal Pradesh',
  HR: 'Haryana',
  JH: 'Jharkhand',
  JK: 'Jammu and Kashmir',
  KA: 'Karnataka',
  KL: 'Kerala',
  LA: 'Ladakh',
  LD: 'Lakshadweep',
  MH: 'Maharashtra',
  ML: 'Meghalaya',
  MN: 'Manipur',
  MP: 'Madhya Pradesh',
  MZ: 'Mizoram',
  NL: 'Nagaland',
  OD: 'Odisha',
  PB: 'Punjab',
  PY: 'Puducherry',
  RJ: 'Rajasthan',
  SK: 'Sikkim',
  TG: 'Telangana',
  TN: 'Tamil Nadu',
  TR: 'Tripura',
  UK: 'Uttarakhand',
  UP: 'Uttar Pradesh',
  WB: 'West Bengal',
};

/** Older or alternative codes → current code. */
const STATE_CODE_ALIASES: Record<string, string> = {
  CG: 'CT',
  OR: 'OD',
  TS: 'TG',
  UT: 'UK',
  DN: 'DH',
  DD: 'DH',
};

export function stateCodeOf(code: string): string | null {
  const upper = code.toUpperCase();
  if (upper in INDIAN_STATES) return upper;
  return STATE_CODE_ALIASES[upper] ?? null;
}

/** State code for a state name, e.g. "West Bengal" → "WB". */
export function stateCodeForName(name: string): string | null {
  const key = enumKey(name);
  for (const [code, stateName] of Object.entries(INDIAN_STATES)) {
    if (enumKey(stateName) === key) return code;
  }
  return null;
}

/** The first Indian state named in a text (an Act title), e.g. "West Bengal Factories Rules" → "WB". */
export function stateNamedIn(text: string): string | null {
  const words = ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
  for (const [code, stateName] of Object.entries(INDIAN_STATES)) {
    if (words.includes(` ${stateName.toLowerCase()} `)) return code;
  }
  return null;
}

export const COUNTRIES: Record<string, string> = { india: 'IN' };

export function countryCodeOf(name: string): string | null {
  const key = enumKey(name);
  if (key in COUNTRIES) return COUNTRIES[key] ?? null;
  return /^[a-z]{2}$/.test(key) ? key.toUpperCase() : null;
}
