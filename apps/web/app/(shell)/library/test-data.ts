// Contract-shaped library records for the unit tests.
import type { Act, Obligation } from '@canopy/contracts';

export const id = (n: number) => `00000000-0000-5000-8000-${n.toString(16).padStart(12, '0')}`;
const FIRM = '00000000-0000-5000-8000-0000000000f1';
const T = '2026-01-01T00:00:00.000Z';
const base = { firmId: FIRM, createdAt: T, updatedAt: T, archivedAt: null, version: 1 };

export function act(n: number, overrides: Partial<Act> = {}): Act {
  return {
    ...base,
    id: id(0x100 + n),
    name: `Act ${n}`,
    shortName: null,
    jurisdiction: 'CENTRAL',
    stateCode: null,
    aliases: [],
    ...overrides,
  } as Act;
}

export function obligation(n: number, overrides: Partial<Obligation> = {}): Obligation {
  return {
    ...base,
    id: id(0x200 + n),
    externalRef: `HRS-CL-${n}`,
    domain: 'HRS',
    jurisdiction: 'CENTRAL',
    stateCode: null,
    actId: id(0x101),
    categoryId: id(0x300),
    title: `Obligation ${n}`,
    description: 'Line one\nLine two',
    applicabilityText: null,
    criticality: 'HIGH',
    timelineType: 'TIME_BASED',
    recurrenceRule: { kind: 'ONE_TIME', dueDate: '2023-03-31' },
    ruleStatus: 'CONFIRMED',
    evidenceRequired: false,
    forms: [],
    logSheets: [],
    libraryVersion: 1,
    ...overrides,
  } as Obligation;
}
