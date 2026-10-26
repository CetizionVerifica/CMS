// The objectives list's URL state, API query and rows (packages.md ISO-6b, model §3.6). The filters are the API's own
// query names, the ones the ISO overview links pass included; `ids` goes to the API's own filter.
import {
  IsoStandardCode,
  type IsoStandard,
  type ManagementSystem,
  type RecurrenceRule,
  type RiskItemView,
} from '@canopy/contracts';
import type { FilterDef } from '@canopy/ui';

import { first, listParam } from '../_lib/people';
import { standardTitleByCode, word } from '../_lib/words';

type Search = Record<string, string | string[] | undefined>;

export type ObjectiveFilters = {
  standard: IsoStandardCode[];
  ownerId?: 'me';
  open?: 'true' | 'false';
  managementSystemId?: string;
  q?: string;
  ids: string[];
};

export function objectiveFilters(search: Search, systemIds: readonly string[]): ObjectiveFilters {
  const open = first(search.open);
  const q = first(search.q)?.trim().slice(0, 200);
  const system = first(search.managementSystemId);
  return {
    standard: listParam(search.standard, IsoStandardCode.options) as IsoStandardCode[],
    ...(first(search.ownerId) === 'me' ? { ownerId: 'me' as const } : {}),
    ...(open === 'true' || open === 'false' ? { open } : {}),
    ...(system && systemIds.includes(system) ? { managementSystemId: system } : {}),
    ...(q ? { q } : {}),
    ids: listParam(search.ids),
  };
}

export function objectivesQuery(f: ObjectiveFilters): Record<string, string> {
  const query: Record<string, string> = {};
  if (f.standard.length) query.standard = f.standard.join(',');
  if (f.ownerId) query.ownerId = f.ownerId;
  if (f.open) query.open = f.open;
  if (f.managementSystemId) query.managementSystemId = f.managementSystemId;
  if (f.q) query.q = f.q;
  if (f.ids.length) query.ids = f.ids.join(',');
  return query;
}

export function objectiveFilterDefs(standards: readonly IsoStandard[]): FilterDef[] {
  return [
    {
      key: 'standard',
      label: 'Standard',
      kind: 'multi',
      order: 'given',
      options: IsoStandardCode.options.map((c) => ({
        value: c,
        label: standardTitleByCode(standards, c),
      })),
    },
    {
      key: 'open',
      label: 'Open or closed',
      kind: 'multi',
      order: 'given',
      options: [
        { value: 'true', label: 'Open' },
        { value: 'false', label: 'Closed' },
      ],
    },
    { key: 'ownerId', label: 'Owner', kind: 'multi', options: [{ value: 'me', label: 'Mine' }] },
  ];
}

export function objectiveFilterValue(f: ObjectiveFilters): Record<string, string[]> {
  return {
    standard: f.standard,
    open: f.open ? [f.open] : [],
    ownerId: f.ownerId ? [f.ownerId] : [],
  };
}

/** How often readings are taken: the choices the form offers, as the contracts' recurrence rules. */
export const READING_CHOICES = {
  MONTHLY: { label: 'Every month', rule: { kind: 'MONTHLY', day: 'LAST', offsetMonths: 0 } },
  QUARTERLY: {
    label: 'Every quarter',
    rule: { kind: 'QUARTERLY', anchor: 'PERIOD_END', days: 0 },
  },
  HALF_YEARLY: {
    label: 'Every half year',
    rule: { kind: 'HALF_YEARLY', anchor: 'PERIOD_END', days: 0 },
  },
  ANNUAL: { label: 'Every year', rule: { kind: 'ANNUAL', month: 3, day: 31 } },
} as const satisfies Record<string, { label: string; rule: RecurrenceRule }>;

export type ReadingChoice = keyof typeof READING_CHOICES;

/** The form's choice for a stored rule, or null when it is another shape (kept as it is unless changed). */
export function readingChoice(rule: RecurrenceRule): ReadingChoice | null {
  for (const [key, choice] of Object.entries(READING_CHOICES)) {
    if (JSON.stringify(choice.rule) === JSON.stringify(rule)) return key as ReadingChoice;
  }
  return null;
}

/** Each system as the objective form offers it: its standards by code, and its live risk items to address. */
export function objectiveSystems(
  systems: readonly Pick<ManagementSystem, 'id' | 'name' | 'standardIds'>[],
  standards: readonly IsoStandard[],
  risks: readonly Pick<
    RiskItemView,
    'id' | 'managementSystemId' | 'kind' | 'activity' | 'description' | 'archivedAt'
  >[],
) {
  return systems.map((s) => ({
    id: s.id,
    name: s.name,
    standards: s.standardIds.flatMap((id) => {
      const std = standards.find((x) => x.id === id);
      return std ? [{ code: std.code, title: standardTitleByCode(standards, std.code) }] : [];
    }),
    risks: risks
      .filter((r) => r.managementSystemId === s.id && r.archivedAt === null)
      .map((r) => ({
        id: r.id,
        label: `${word('RiskKind', r.kind)}: ${r.activity}, ${r.description.slice(0, 80)}`,
      })),
  }));
}
