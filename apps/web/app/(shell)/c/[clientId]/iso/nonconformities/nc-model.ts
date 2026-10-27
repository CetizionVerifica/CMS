// The nonconformity log's URL state, API query and rows (packages.md ISO-6c, model §3.10). The filters are the API's own
// query names, the ones the ISO overview's nonconformity and incident links pass included; `ids` is the exact list an
// overview number counts and goes to the API's own filter, since the log is paged. Nothing here filters the rows.
import {
  NcSeverity,
  NcSource,
  NcState,
  type IsoClause,
  type IsoStandard,
  type IsoStandardCode,
  type ManagementSystem,
  type NonconformityView,
  type RiskItemView,
  type Unit,
} from '@canopy/contracts';
import type { FilterDef } from '@canopy/ui';

import { first, listParam, nameOf, type PersonOption } from '../_lib/people';
import { standardTitleByCode, WORDS, word } from '../_lib/words';
import { clauseOptions } from '../documents/documents-model';

type Search = Record<string, string | string[] | undefined>;

export type NcFilters = {
  state: NcState[];
  source: NcSource[];
  severity: NcSeverity[];
  ownerId?: 'me';
  approverId?: 'me';
  incident?: 'true';
  overdue?: 'true';
  managementSystemId?: string;
  q?: string;
  ids: string[];
};

export function ncFilters(search: Search, systemIds: readonly string[]): NcFilters {
  const q = first(search.q)?.trim().slice(0, 200);
  const system = first(search.managementSystemId);
  return {
    state: listParam(search.state, NcState.options) as NcState[],
    source: listParam(search.source, NcSource.options) as NcSource[],
    severity: listParam(search.severity, NcSeverity.options) as NcSeverity[],
    ...(first(search.ownerId) === 'me' ? { ownerId: 'me' as const } : {}),
    ...(first(search.approverId) === 'me' ? { approverId: 'me' as const } : {}),
    ...(first(search.incident) === 'true' ? { incident: 'true' as const } : {}),
    ...(first(search.overdue) === 'true' ? { overdue: 'true' as const } : {}),
    ...(system && systemIds.includes(system) ? { managementSystemId: system } : {}),
    ...(q ? { q } : {}),
    ids: listParam(search.ids),
  };
}

/** The filters the NC log export takes: the log's own, without paging or `ids` (exports take none). */
export function ncExportQuery(f: NcFilters): Record<string, string> {
  const query: Record<string, string> = {};
  if (f.state.length) query.state = f.state.join(',');
  if (f.source.length) query.source = f.source.join(',');
  if (f.severity.length) query.severity = f.severity.join(',');
  if (f.ownerId) query.ownerId = f.ownerId;
  if (f.approverId) query.approverId = f.approverId;
  if (f.incident) query.incident = f.incident;
  if (f.overdue) query.overdue = f.overdue;
  if (f.managementSystemId) query.managementSystemId = f.managementSystemId;
  if (f.q) query.q = f.q;
  return query;
}

/** The API query: the export's filters and `ids`. */
export function ncsQuery(f: NcFilters): Record<string, string> {
  const query = ncExportQuery(f);
  if (f.ids.length) query.ids = f.ids.join(',');
  return query;
}

const options = <T extends string>(values: readonly T[], words: Readonly<Record<T, string>>) =>
  values.map((v) => ({ value: v, label: words[v] }));

export function ncFilterDefs(): FilterDef[] {
  return [
    {
      key: 'state',
      label: 'State',
      kind: 'multi',
      order: 'given',
      options: options(NcState.options, WORDS.NcState),
    },
    {
      key: 'source',
      label: 'Source',
      kind: 'multi',
      order: 'given',
      options: options(NcSource.options, WORDS.NcSource),
    },
    {
      key: 'severity',
      label: 'Severity',
      kind: 'multi',
      order: 'given',
      options: options(NcSeverity.options, WORDS.NcSeverity),
    },
    { key: 'overdue', label: 'Due', kind: 'multi', options: [{ value: 'true', label: 'Overdue' }] },
    {
      key: 'incident',
      label: 'Incidents',
      kind: 'multi',
      options: [{ value: 'true', label: 'Incidents and near misses only' }],
    },
    { key: 'ownerId', label: 'Owner', kind: 'multi', options: [{ value: 'me', label: 'Mine' }] },
    {
      key: 'approverId',
      label: 'Approver',
      kind: 'multi',
      options: [{ value: 'me', label: 'Mine' }],
    },
  ];
}

export function ncFilterValue(f: NcFilters): Record<string, string[]> {
  return {
    state: f.state,
    source: f.source,
    severity: f.severity,
    overdue: f.overdue ? [f.overdue] : [],
    incident: f.incident ? [f.incident] : [],
    ownerId: f.ownerId ? [f.ownerId] : [],
    approverId: f.approverId ? [f.approverId] : [],
  };
}

/** What a record is called: an incident, a near miss or a nonconformity, with its number. */
export function ncName(nc: Pick<NonconformityView, 'source' | 'number'>): string {
  const kind =
    nc.source === 'INCIDENT'
      ? 'Incident'
      : nc.source === 'NEAR_MISS'
        ? 'Near miss'
        : 'Nonconformity';
  return `${kind} ${nc.number}`;
}

/** The first line of a description, short enough for a list or a page title. */
export function ncSummary(description: string, max = 90): string {
  const line = description.split('\n')[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export type NcRow = {
  id: string;
  title: string;
  sub: string;
  unit: string;
  ownerName: string;
  approverName: string;
  nc: NonconformityView;
};

export function ncRows(
  ncs: readonly NonconformityView[],
  units: readonly Pick<Unit, 'id' | 'name'>[],
  people: readonly PersonOption[],
): NcRow[] {
  return ncs.map((nc) => ({
    id: nc.id,
    title: ncSummary(nc.description),
    sub: `${ncName(nc)} · ${word('NcSource', nc.source)} · ${word('NcSeverity', nc.severity)}`,
    unit: nc.unitId ? (units.find((u) => u.id === nc.unitId)?.name ?? 'Unknown unit') : 'All units',
    ownerName: nameOf(people, nc.ownerId),
    approverName: nameOf(people, nc.approverId),
    nc,
  }));
}

/** Whether the record is still being worked (not CLOSED or CANCELLED). */
export function ncOpen(nc: Pick<NonconformityView, 'state'>): boolean {
  return nc.state !== 'CLOSED' && nc.state !== 'CANCELLED';
}

/**
 * Whether severity and the incident outcome may still change (model §3.10): OPEN or ROOT_CAUSE_FOUND. On an NC raised
 * from a finding the severity follows the finding, so the reassign form leaves it out.
 */
export function severityOpen(nc: Pick<NonconformityView, 'state'>): boolean {
  return nc.state === 'OPEN' || nc.state === 'ROOT_CAUSE_FOUND';
}

export type NcSystemOption = {
  id: string;
  name: string;
  unitIds: string[];
  standards: { code: IsoStandardCode; title: string }[];
  clauses: { id: string; label: string }[];
  /** The system's live risk items, one of which a nonconformity can come from. */
  risks: { id: string; label: string }[];
};

/** Each system as the raise form offers it: its standards, clauses, units and live risk items. */
export function ncSystems(
  systems: readonly Pick<ManagementSystem, 'id' | 'name' | 'standardIds' | 'unitIds'>[],
  standards: readonly IsoStandard[],
  clauses: readonly IsoClause[],
  risks: readonly Pick<
    RiskItemView,
    'id' | 'managementSystemId' | 'kind' | 'activity' | 'description' | 'archivedAt'
  >[],
): NcSystemOption[] {
  return systems.map((s) => ({
    id: s.id,
    name: s.name,
    unitIds: [...s.unitIds],
    standards: s.standardIds.flatMap((id) => {
      const std = standards.find((x) => x.id === id);
      return std ? [{ code: std.code, title: standardTitleByCode(standards, std.code) }] : [];
    }),
    clauses: clauseOptions(clauses, standards, s.standardIds),
    risks: risks
      .filter((r) => r.managementSystemId === s.id && r.archivedAt === null)
      .map((r) => ({
        id: r.id,
        label: `${word('RiskKind', r.kind)}: ${r.activity}, ${r.description.slice(0, 80)}`,
      })),
  }));
}
