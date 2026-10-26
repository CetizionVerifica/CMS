// The document list's URL state and rows (packages.md ISO-6a). The filters are the API's own query names; `ids` is the
// exact list an overview number counts, which goes to the API's own filter (ISO-1a4).
import {
  DocumentStatus,
  DocumentType,
  type DocumentView,
  type IsoClause,
  type IsoStandard,
} from '@canopy/contracts';
import type { FilterDef } from '@canopy/ui';

import { first, listParam, nameOf, type PersonOption } from '../_lib/people';
import { standardTitle, word, WORDS } from '../_lib/words';
import { compareClauses } from '../checklist/checklist-model';

type Search = Record<string, string | string[] | undefined>;

export type DocumentFilters = {
  type: string[];
  status: string[];
  ownerId?: 'me';
  q?: string;
  managementSystemId?: string;
  ids: string[];
};

export function documentFilters(search: Search, systemIds: readonly string[]): DocumentFilters {
  const q = first(search.q)?.trim().slice(0, 200);
  const system = first(search.managementSystemId);
  return {
    type: listParam(search.type, DocumentType.options),
    status: listParam(search.status, DocumentStatus.options),
    ...(first(search.ownerId) === 'me' ? { ownerId: 'me' as const } : {}),
    ...(q ? { q } : {}),
    ...(system && systemIds.includes(system) ? { managementSystemId: system } : {}),
    ids: listParam(search.ids),
  };
}

/**
 * The API query. With `ids` the API drops its ACTIVE-only default, so an obsolete document the overview counted is
 * listed too.
 */
export function documentsQuery(f: DocumentFilters): Record<string, string> {
  const query: Record<string, string> = {};
  if (f.type.length) query.type = f.type.join(',');
  if (f.status.length) query.status = f.status.join(',');
  if (f.ownerId) query.ownerId = f.ownerId;
  if (f.q) query.q = f.q;
  if (f.managementSystemId) query.managementSystemId = f.managementSystemId;
  if (f.ids.length) query.ids = f.ids.join(',');
  return query;
}

export function documentFilterDefs(): FilterDef[] {
  const options = (words: Readonly<Record<string, string>>) =>
    Object.entries(words).map(([value, label]) => ({ value, label }));
  return [
    {
      key: 'type',
      label: 'Type',
      kind: 'multi',
      order: 'given',
      options: options(WORDS.DocumentType),
    },
    {
      key: 'status',
      label: 'Status',
      kind: 'multi',
      order: 'given',
      options: options(WORDS.DocumentStatus),
    },
    { key: 'ownerId', label: 'Owner', kind: 'multi', options: [{ value: 'me', label: 'Mine' }] },
  ];
}

export type DocumentRow = {
  id: string;
  code: string;
  title: string;
  type: string;
  revision: string;
  ownerName: string;
  approverName: string;
  doc: DocumentView;
};

export function documentRows(
  docs: readonly DocumentView[],
  people: readonly PersonOption[],
): DocumentRow[] {
  return docs.map((d) => ({
    id: d.id,
    code: d.code,
    title: d.title,
    type: word('DocumentType', d.type),
    revision: d.currentRevision ?? 'None approved yet',
    ownerName: nameOf(people, d.ownerId),
    approverName: nameOf(people, d.approverId),
    doc: d,
  }));
}

/** The clauses a record can name, of the given standards: "ISO 9001 7.5 Documented information". */
export function clauseOptions(
  clauses: readonly IsoClause[],
  standards: readonly IsoStandard[],
  standardIds: readonly string[],
): { id: string; label: string }[] {
  return clauses
    .filter((c) => standardIds.includes(c.standardId))
    .sort(
      (a, b) =>
        standardIds.indexOf(a.standardId) - standardIds.indexOf(b.standardId) ||
        compareClauses(a.number, b.number),
    )
    .map((c) => ({
      id: c.id,
      label: `${standardTitle(standards, c.standardId)} ${c.number} ${c.title}`,
    }));
}

/** A revision label the API will take next: after "B" comes "C", after "2" comes "3"; otherwise the person types one. */
export function nextRevisionLabel(current: string | null): string {
  if (current === null) return 'A';
  if (/^\d+$/.test(current)) return String(Number(current) + 1);
  if (/^[A-Y]$/.test(current)) return String.fromCharCode(current.charCodeAt(0) + 1);
  return '';
}
