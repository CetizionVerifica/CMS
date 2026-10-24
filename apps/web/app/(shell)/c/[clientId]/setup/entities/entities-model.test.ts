import type { Company, Location, Unit } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';

import { companyRows, locationLabel, locationOptions, unitRows, unitsText } from './entities-model';

const base = {
  firmId: 'f',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  archivedAt: null,
};
const company = (id: string, name: string): Company => ({
  ...base,
  id,
  clientId: 'c',
  name,
  version: 1,
});
const unit = (id: string, name: string, companyId: string, locationId: string): Unit => ({
  ...base,
  id,
  clientId: 'c',
  companyId,
  locationId,
  name,
  version: 2,
});
const location = (id: string, city: string | null, state: string | null): Location => ({
  ...base,
  id,
  country: 'India',
  countryCode: 'IN',
  state,
  stateCode: state ? 'MH' : null,
  city,
});

describe('entities model', () => {
  it('labels a location with what it has', () => {
    expect(locationLabel(location('l', 'Pune', 'Maharashtra'))).toBe('Pune, Maharashtra, India');
    expect(locationLabel(location('l', null, null))).toBe('India');
  });

  it('counts units per company and sorts units by company, then name', () => {
    const companies = [company('a', 'Osprey Textiles'), company('b', 'Kestrel Aluminium')];
    const locations = [
      location('l1', 'Pune', 'Maharashtra'),
      location('l2', 'Chennai', 'Tamil Nadu'),
    ];
    const units = [
      unit('u1', 'Riverbend Plant', 'a', 'l1'),
      unit('u2', 'Stonebridge Office', 'b', 'l2'),
      unit('u3', 'Highmoor Site', 'b', 'gone'),
    ];
    expect(companyRows(companies, units).map((c) => [c.name, c.units])).toEqual([
      ['Osprey Textiles', 1],
      ['Kestrel Aluminium', 2],
    ]);
    expect(unitRows(units, companies, locations)).toEqual([
      expect.objectContaining({
        name: 'Highmoor Site',
        company: 'Kestrel Aluminium',
        location: '—',
      }),
      expect.objectContaining({
        name: 'Stonebridge Office',
        location: 'Chennai, Tamil Nadu, India',
        version: 2,
      }),
      expect.objectContaining({ name: 'Riverbend Plant', company: 'Osprey Textiles' }),
    ]);
    expect(unitRows([unit('u', 'X', 'nope', 'l1')], [], locations)[0]!.company).toBe('—');
    expect(locationOptions(locations).map((o) => o.label)).toEqual([
      'Chennai, Tamil Nadu, India',
      'Pune, Maharashtra, India',
    ]);
    expect([unitsText(1), unitsText(0), unitsText(3)]).toEqual(['1 unit', '0 units', '3 units']);
  });
});
