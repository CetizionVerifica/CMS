'use client';
// Obligations in the firm library, with the columns the register's Excel users know: ID, title, Act, domain,
// jurisdiction and criticality. "To review" marks a recurrence inferred on import and not yet confirmed.
import { DataTable, type DataTableProps } from '@canopy/ui';
import type { ReactNode } from 'react';

import type { ObligationItem } from './library-model';

const columns: DataTableProps<ObligationItem>['columns'] = [
  {
    id: 'ref',
    header: 'ID',
    accessorFn: (row) => (row.ref ?? '') as never,
    meta: { type: 'text' },
  },
  {
    id: 'title',
    header: 'Obligation',
    accessorFn: (row) => row.title as never,
    meta: { type: 'title', locked: true },
  },
  {
    id: 'act',
    header: 'Act',
    accessorFn: (row) => row.actName as never,
    meta: { type: 'text' },
  },
  {
    id: 'domain',
    header: 'Domain',
    accessorFn: (row) => row.domain as never,
    meta: { type: 'text' },
  },
  {
    id: 'jurisdiction',
    header: 'Jurisdiction',
    accessorFn: (row) => row.jurisdiction as never,
    meta: { type: 'text' },
  },
  {
    id: 'criticality',
    header: 'Criticality',
    accessorFn: (row) => row.criticality as never,
    meta: { type: 'criticality' },
  },
  {
    id: 'rule',
    header: 'Recurrence',
    accessorFn: (row) => (row.toReview ? 1 : 0) as never,
    cell: ({ row }) =>
      row.original.toReview ? (
        <span className="text-body-strong text-warn-ink">To review</span>
      ) : (
        <span className="text-muted">Confirmed</span>
      ),
  },
];

export function ObligationsTable({ items, empty }: { items: ObligationItem[]; empty: ReactNode }) {
  return (
    <DataTable
      label="Obligations"
      toolbar={false}
      columns={columns}
      data={items}
      rowId={(row) => row.id}
      rowLabel={(row) => (row.ref ? `${row.ref}, ${row.title}` : row.title)}
      empty={empty}
      countNoun={{ one: 'obligation', other: 'obligations' }}
    />
  );
}
