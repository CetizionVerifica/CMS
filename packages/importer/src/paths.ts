import { countryCodeOf } from './reference.js';
import { collapse } from './text.js';

/** Hierarchy paths from the register: "Group/ Company/ Unit" and "Country/ State/ City". */

export interface OrgPath {
  company: string;
  unit: string;
}

export interface LocationPath {
  country: string;
  countryCode: string;
  state: string | null;
  city: string | null;
}

/** "Group/ Company/ Unit" → company and unit (the group is the client the import runs for). */
export function splitOrganization(value: string): OrgPath | null {
  const parts = value
    .split('/')
    .map((part) => collapse(part))
    .filter((part) => part !== '');
  if (parts.length < 2) return null;
  return { company: parts[parts.length - 2] ?? '', unit: parts[parts.length - 1] ?? '' };
}

/** "Country/ State/ City"; null when the country is not recognised. */
export function splitLocation(value: string): LocationPath | null {
  const parts = value
    .split('/')
    .map((part) => collapse(part))
    .filter((part) => part !== '');
  const [country, state, city] = parts;
  const countryCode = country === undefined ? null : countryCodeOf(country);
  if (country === undefined || countryCode === null || parts.length > 3) return null;
  return { country, countryCode, state: state ?? null, city: city ?? null };
}
