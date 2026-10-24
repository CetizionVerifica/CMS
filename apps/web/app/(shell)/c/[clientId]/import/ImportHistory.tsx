'use client';
// The client's imports, newest first. An open one picks up where it stopped; a closed one shows its result.
import { DataTable, formatTimestamp, type DataTableProps } from '@canopy/ui';
import NextLink from 'next/link';
import { useMemo, type ReactNode } from 'react';

import type { HistoryItem } from './import-model';

const renderLink = ({
  href,
  children,
  ...rest
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) => (
  <NextLink href={href} {...rest}>
    {children}
  </NextLink>
);

const columnsFor = (timeZone: string): DataTableProps<HistoryItem>['columns'] => [
  {
    id: 'fileName',
    header: 'Workbook',
    accessorFn: (row) => row.fileName as never,
    meta: { type: 'title', locked: true },
  },
  {
    id: 'started',
    header: 'Started',
    accessorFn: (row) => formatTimestamp(row.startedAt, timeZone) as never,
    meta: { type: 'text' },
    enableSorting: false,
  },
  {
    id: 'status',
    header: 'Status',
    accessorFn: (row) => (row.open ? `${row.status} · continue` : row.status) as never,
    meta: { type: 'text' },
  },
  {
    id: 'rows',
    header: 'Rows',
    accessorFn: (row) => (row.rows ?? 0) as never,
    cell: ({ row }) => (row.original.rows === null ? '—' : row.original.rows),
    meta: { type: 'number' },
  },
];

export function ImportHistory({ items, timeZone }: { items: HistoryItem[]; timeZone: string }) {
  const columns = useMemo(() => columnsFor(timeZone), [timeZone]);
  return (
    <DataTable
      label="Imports"
      toolbar={false}
      columns={columns}
      data={items}
      rowId={(row) => row.id}
      rowLabel={(row) => row.fileName}
      rowHref={(row) => row.href}
      renderLink={renderLink}
      countNoun={{ one: 'import', other: 'imports' }}
    />
  );
}
