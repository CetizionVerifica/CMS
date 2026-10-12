'use client';
// The portfolio grid: one row per client, the row opens the client's overview and the overdue count opens the
// register filtered to those rows. Overdue comes right after the name, so a phone shows it without scrolling sideways.
// Client Component because DataTable sorts and handles the keyboard in the browser.
import {
  DataTable,
  formatNumber,
  formatPercent,
  formatTimestamp,
  ScoreRing,
  type DataTableProps,
} from '@canopy/ui';
import NextLink from 'next/link';
import type { ReactNode } from 'react';

import type { PortfolioItem } from './portfolio-model';

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

const columns: DataTableProps<PortfolioItem>['columns'] = [
  {
    id: 'client',
    header: 'Client',
    accessorFn: (row) => row.clientName as never,
    meta: { type: 'title', locked: true },
  },
  {
    id: 'overdue',
    header: 'Overdue',
    accessorFn: (row) => row.overdue as never,
    meta: { type: 'number' },
    cell: ({ row }) => {
      const { overdue, overdueHref, clientName } = row.original;
      if (overdue === 0) return <span className="tabular text-muted">0</span>;
      return (
        <NextLink
          href={overdueHref}
          className="tabular font-semibold text-crit-ink underline-offset-2 hover:underline focus-visible:underline"
          aria-label={`${formatNumber(overdue)} overdue at ${clientName}, view in register`}
        >
          {formatNumber(overdue)}
        </NextLink>
      );
    },
  },
  {
    id: 'dueThisWeek',
    header: 'Due this week',
    accessorFn: (row) => row.dueThisWeek as never,
    meta: { type: 'number' },
  },
  {
    id: 'score',
    header: 'Score',
    accessorFn: (row) => (row.score ?? -1) as never,
    meta: { type: 'number' },
    cell: ({ row }) => {
      const { score, clientName } = row.original;
      return (
        <span className="flex items-center justify-end gap-2">
          <span className="tabular">{score === null ? 'No items due' : formatPercent(score)}</span>
          {score === null ? null : (
            <ScoreRing value={score} size="sm" label={`${clientName} compliance score`} />
          )}
        </span>
      );
    },
  },
  {
    id: 'lastActivity',
    header: 'Last activity',
    accessorFn: (row) => (row.lastActivityAt ?? '') as never,
    cell: ({ row }) => {
      const { lastActivityAt, timeZone } = row.original;
      return lastActivityAt ? (
        <span className="tabular">{formatTimestamp(lastActivityAt, timeZone)}</span>
      ) : (
        <span className="text-muted">No activity yet</span>
      );
    },
  },
];

export function PortfolioTable({ items }: { items: PortfolioItem[] }) {
  return (
    <DataTable
      label="Clients"
      columns={columns}
      data={items}
      rowId={(row) => row.clientId}
      rowLabel={(row) => row.clientName}
      rowHref={(row) => row.overviewHref}
      renderLink={renderLink}
      toolbar={false}
      countNoun={{ one: 'client', other: 'clients' }}
    />
  );
}
