// The risk register's URL state, API query and rows (packages.md ISO-6b, model §3.5). The filters are the API's own query
// names, the ones the ISO overview links pass included; `ids` is the exact list an overview number counts and goes to
// the API's own filter, since the list is paged. A URL without `kind` shows every kind, and nothing here adds a filter
// the URL does not name.
import { RiskKind, type RiskItemView, type Unit } from '@canopy/contracts';
import type { FilterDef } from '@canopy/ui';

import { first, hrefWith, listParam, nameOf, type PersonOption } from '../_lib/people';
import { word, WORDS } from '../_lib/words';

type Search = Record<string, string | string[] | undefined>;

export type RiskFilters = {
  kind?: RiskKind;
  significant?: 'true' | 'false';
  climateRelated?: 'true' | 'false';
  ownerId?: 'me';
  includeArchived?: 'true';
  managementSystemId?: string;
  q?: string;
  ids: string[];
};

const bool = (v: string | undefined) => (v === 'true' || v === 'false' ? v : undefined);

export function riskFilters(search: Search, systemIds: readonly string[]): RiskFilters {
  const kind = first(search.kind);
  const q = first(search.q)?.trim().slice(0, 200);
  const system = first(search.managementSystemId);
  const significant = bool(first(search.significant));
  const climate = bool(first(search.climateRelated));
  return {
    ...((RiskKind.options as readonly string[]).includes(kind ?? '')
      ? { kind: kind as RiskKind }
      : {}),
    ...(significant ? { significant } : {}),
    ...(climate ? { climateRelated: climate } : {}),
    ...(first(search.ownerId) === 'me' ? { ownerId: 'me' as const } : {}),
    ...(first(search.includeArchived) === 'true' ? { includeArchived: 'true' as const } : {}),
    ...(system && systemIds.includes(system) ? { managementSystemId: system } : {}),
    ...(q ? { q } : {}),
    ids: listParam(search.ids),
  };
}

/** The filters the register export takes: the list's own, without paging or `ids` (exports take none). */
export function riskExportQuery(f: RiskFilters): Record<string, string> {
  const query: Record<string, string> = {};
  if (f.kind) query.kind = f.kind;
  if (f.significant) query.significant = f.significant;
  if (f.climateRelated) query.climateRelated = f.climateRelated;
  if (f.ownerId) query.ownerId = f.ownerId;
  if (f.includeArchived) query.includeArchived = f.includeArchived;
  if (f.managementSystemId) query.managementSystemId = f.managementSystemId;
  if (f.q) query.q = f.q;
  return query;
}

/** The API query: the export's filters and `ids`. */
export function risksQuery(f: RiskFilters): Record<string, string> {
  const query = riskExportQuery(f);
  if (f.ids.length) query.ids = f.ids.join(',');
  return query;
}

const yesNo = (yes: string, no: string) => [
  { value: 'true', label: yes },
  { value: 'false', label: no },
];

export function riskFilterDefs(): FilterDef[] {
  return [
    {
      key: 'significant',
      label: 'Significance',
      kind: 'multi',
      order: 'given',
      options: yesNo('Significant', 'Not significant'),
    },
    {
      key: 'climateRelated',
      label: 'Climate',
      kind: 'multi',
      order: 'given',
      options: yesNo('Climate related', 'Not climate related'),
    },
    { key: 'ownerId', label: 'Owner', kind: 'multi', options: [{ value: 'me', label: 'Mine' }] },
    {
      key: 'includeArchived',
      label: 'Archived',
      kind: 'multi',
      options: [{ value: 'true', label: 'Include archived' }],
    },
  ];
}

/** The filter bar's value. A yes/no filter is one choice, so picking both answers clears it. */
export function riskFilterValue(f: RiskFilters): Record<string, string[]> {
  return {
    significant: f.significant ? [f.significant] : [],
    climateRelated: f.climateRelated ? [f.climateRelated] : [],
    ownerId: f.ownerId ? [f.ownerId] : [],
    includeArchived: f.includeArchived ? [f.includeArchived] : [],
  };
}

const KIND_PLURALS: Record<RiskKind, string> = {
  RISK: 'Risks',
  OPPORTUNITY: 'Opportunities',
  ASPECT: 'Aspects',
  HAZARD: 'Hazards',
};

/** The tabs: All, then one per kind, each the list's URL with that kind and no `ids`. */
export function kindTabs(
  path: string,
  f: RiskFilters,
): { label: string; href: string; current: boolean }[] {
  const keep = { ...riskExportQuery(f), kind: undefined };
  return [
    { label: 'All', href: hrefWith(path, keep), current: f.kind === undefined },
    ...RiskKind.options.map((k) => ({
      label: KIND_PLURALS[k],
      href: hrefWith(path, { ...keep, kind: k }),
      current: f.kind === k,
    })),
  ];
}

/** "12 (3 × 4)": a rating with the two scores behind it. */
export function ratingText(
  rating: number | null,
  likelihood: number | null,
  severity: number | null,
) {
  return rating === null ? 'Not rated' : `${rating} (${likelihood} × ${severity})`;
}

export type RiskRow = {
  id: string;
  title: string;
  sub: string;
  unit: string;
  rating: number;
  ratingText: string;
  residualText: string;
  ownerName: string;
  risk: RiskItemView;
};

export function riskRows(
  risks: readonly RiskItemView[],
  units: readonly Pick<Unit, 'id' | 'name'>[],
  people: readonly PersonOption[],
): RiskRow[] {
  return risks.map((r) => ({
    id: r.id,
    title: r.description,
    sub: `${word('RiskKind', r.kind)} · ${r.activity}`,
    unit: r.unitId ? (units.find((u) => u.id === r.unitId)?.name ?? 'Unknown unit') : 'All units',
    rating: r.rating,
    ratingText: ratingText(r.rating, r.likelihood, r.severity),
    residualText: ratingText(r.residualRating, r.residualLikelihood, r.residualSeverity),
    ownerName: nameOf(people, r.ownerId),
    risk: r,
  }));
}

/** The kind-specific fields of a risk item in words, for its record page (model §3.5). */
export function kindDetails(r: RiskItemView): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  if (r.kind === 'ASPECT') {
    rows.push({ label: 'Environmental impact', value: r.impact ?? '' });
    rows.push({
      label: 'Life-cycle stages',
      value: r.lifeCycleStages.map((s) => WORDS.LifeCycleStage[s]).join(', '),
    });
    rows.push({
      label: 'Control or influence',
      value: r.controlType ? word('AspectControlType', r.controlType) : '',
    });
  }
  if (r.kind === 'HAZARD') {
    rows.push({ label: 'Harm', value: r.impact ?? '' });
    rows.push({ label: 'Routine', value: r.routine ? 'Routine' : 'Non-routine' });
    rows.push({
      label: 'Who is exposed',
      value: r.personsExposed.map((p) => WORDS.PersonsExposed[p]).join(', '),
    });
  }
  if ((r.kind === 'ASPECT' || r.kind === 'HAZARD') && r.condition) {
    rows.push({ label: 'Operating condition', value: word('OperatingCondition', r.condition) });
  }
  return rows;
}

/** The second rating axis: benefit for an opportunity, severity otherwise (model §3.5). */
export function secondAxis(kind: RiskKind): string {
  return kind === 'OPPORTUNITY' ? 'Benefit' : 'Severity';
}
