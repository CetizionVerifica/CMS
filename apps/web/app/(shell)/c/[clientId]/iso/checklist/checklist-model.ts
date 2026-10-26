// The clause checklist's URL state and rows. The rows, their status, N/A state and the steps on offer are the API's;
// this file reads the URL into the API's own filter names and words the rows.
import {
  ClauseNaState,
  ClauseStatus,
  type ClauseAssessmentView,
  type IsoStandard,
} from '@canopy/contracts';
import type { FilterDef } from '@canopy/ui';

import { first, listParam, nameOf, type PersonOption } from '../_lib/people';
import { standardTitle, WORDS } from '../_lib/words';

export type ChecklistFilters = {
  standardId: string[];
  status: string[];
  naState: string[];
  ownerId?: string;
};

type Search = Record<string, string | string[] | undefined>;

/** The filters in the URL, keeping only values the API knows. */
export function filtersFrom(search: Search, standardIds: readonly string[]): ChecklistFilters {
  const owner = first(search.ownerId);
  return {
    standardId: listParam(search.standardId, standardIds),
    status: listParam(search.status, ClauseStatus.options),
    naState: listParam(search.naState, ClauseNaState.options),
    ...(owner === 'me' ? { ownerId: 'me' } : {}),
  };
}

/** The filters as the API's checklist query. */
export function checklistQuery(f: ChecklistFilters): Record<string, string> {
  const query: Record<string, string> = {};
  if (f.standardId.length) query.standardId = f.standardId.join(',');
  if (f.status.length) query.status = f.status.join(',');
  if (f.naState.length) query.naState = f.naState.join(',');
  if (f.ownerId) query.ownerId = f.ownerId;
  return query;
}

export function filterDefs(
  standards: readonly IsoStandard[],
  systemStandardIds: string[],
): FilterDef[] {
  const options = (words: Readonly<Record<string, string>>) =>
    Object.entries(words).map(([value, label]) => ({ value, label }));
  return [
    {
      key: 'standardId',
      label: 'Standard',
      kind: 'multi',
      order: 'given',
      options: systemStandardIds.map((id) => ({ value: id, label: standardTitle(standards, id) })),
    },
    {
      key: 'status',
      label: 'Status',
      kind: 'multi',
      order: 'given',
      options: options(WORDS.ClauseStatus),
    },
    {
      key: 'naState',
      label: 'Not applicable',
      kind: 'multi',
      order: 'given',
      options: options(WORDS.ClauseNaState),
    },
    {
      key: 'ownerId',
      label: 'Owner',
      kind: 'multi',
      options: [{ value: 'me', label: 'Mine' }],
    },
  ];
}

export type ChecklistRow = {
  id: string;
  clause: string;
  standard: string;
  ownerName: string;
  row: ClauseAssessmentView;
};

/** Natural clause order: 4.1 before 4.10, 7.1.5.2 after 7.1.5.1. */
export function compareClauses(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

export function checklistRows(
  rows: readonly ClauseAssessmentView[],
  standards: readonly IsoStandard[],
  people: readonly PersonOption[],
  standardOrder: readonly string[],
): ChecklistRow[] {
  return [...rows]
    .sort(
      (a, b) =>
        standardOrder.indexOf(a.standardId) - standardOrder.indexOf(b.standardId) ||
        compareClauses(a.clauseNumber, b.clauseNumber),
    )
    .map((row) => ({
      id: row.id,
      clause: `${row.clauseNumber} ${row.clauseTitle}`,
      standard: standardTitle(standards, row.standardId),
      ownerName: row.ownerId ? nameOf(people, row.ownerId) : 'Nobody yet',
      row,
    }));
}
