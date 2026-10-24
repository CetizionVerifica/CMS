'use client';
// The audit trail: one row per event, newest first. Client Component because DataTable handles the keyboard in the
// browser and the time is shown in the client's time zone.
import { DataTable, formatTimestamp, type DataTableProps } from '@canopy/ui';
import type { ReactNode } from 'react';

import type { AuditRow } from './audit-model';

function columns(timeZone: string): DataTableProps<AuditRow>['columns'] {
  return [
    {
      id: 'what',
      header: 'What happened',
      accessorFn: (row) => row.what as never,
      meta: { type: 'title', locked: true },
      enableSorting: false,
    },
    {
      id: 'record',
      header: 'Record',
      accessorFn: (row) => row.record as never,
      meta: { type: 'text' },
      enableSorting: false,
    },
    {
      id: 'who',
      header: 'Who',
      accessorFn: (row) => row.who as never,
      meta: { type: 'text' },
      enableSorting: false,
    },
    {
      id: 'at',
      header: 'When',
      accessorFn: (row) => row.at as never,
      meta: { type: 'text' },
      enableSorting: false,
      cell: ({ row }) => (
        <span className="tabular whitespace-nowrap">
          {formatTimestamp(row.original.at, timeZone)}
        </span>
      ),
    },
    {
      id: 'details',
      header: 'Details',
      accessorFn: (row) => row.details.join('; ') as never,
      meta: { type: 'text' },
      enableSorting: false,
      cell: ({ row }) => {
        const { details, reason } = row.original;
        if (details.length === 0 && !reason) return <span className="text-muted">—</span>;
        return (
          <div className="flex flex-col gap-0.5">
            {details.map((line) => (
              <span key={line}>{line}</span>
            ))}
            {reason ? <span className="text-muted">Reason: {reason}</span> : null}
          </div>
        );
      },
    },
  ];
}

export function AuditTable({
  rows,
  timeZone,
  empty,
}: {
  rows: AuditRow[];
  timeZone: string;
  empty: ReactNode;
}) {
  return (
    <DataTable
      label="Audit trail"
      toolbar={false}
      columns={columns(timeZone)}
      data={rows}
      rowId={(row) => row.id}
      rowLabel={(row) => row.what}
      empty={empty}
      countNoun={{ one: 'event', other: 'events' }}
    />
  );
}
