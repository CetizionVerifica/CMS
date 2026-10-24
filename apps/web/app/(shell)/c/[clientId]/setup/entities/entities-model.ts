// Shapes the entities screen shows: a client's companies and their units (plants, sites, offices), each unit with
// its location. Formatting only; which obligations a unit's state brings in is the engine's job.
import type { Company, Location, Unit } from '@canopy/contracts';

/** "Pune, Maharashtra, India", leaving out what the location does not have. */
export const locationLabel = (l: Pick<Location, 'city' | 'state' | 'country'>) =>
  [l.city, l.state, l.country].filter(Boolean).join(', ');

export type CompanyRow = { id: string; name: string; version: number; units: number };

export type UnitRow = {
  id: string;
  name: string;
  version: number;
  companyId: string;
  company: string;
  locationId: string;
  location: string;
};

export type LocationOption = { value: string; label: string };

export function companyRows(companies: readonly Company[], units: readonly Unit[]): CompanyRow[] {
  return companies.map((c) => ({
    id: c.id,
    name: c.name,
    version: c.version,
    units: units.filter((u) => u.companyId === c.id).length,
  }));
}

export function unitRows(
  units: readonly Unit[],
  companies: readonly Company[],
  locations: readonly Location[],
): UnitRow[] {
  const companyName = new Map(companies.map((c) => [c.id, c.name]));
  const locationName = new Map(locations.map((l) => [l.id, locationLabel(l)]));
  return units
    .map((u) => ({
      id: u.id,
      name: u.name,
      version: u.version,
      companyId: u.companyId,
      company: companyName.get(u.companyId) ?? '—',
      locationId: u.locationId,
      location: locationName.get(u.locationId) ?? '—',
    }))
    .sort((a, b) => a.company.localeCompare(b.company) || a.name.localeCompare(b.name));
}

export const locationOptions = (locations: readonly Location[]): LocationOption[] =>
  locations
    .map((l) => ({ value: l.id, label: locationLabel(l) }))
    .sort((a, b) => a.label.localeCompare(b.label));

export const unitsText = (n: number) => (n === 1 ? '1 unit' : `${n} units`);
