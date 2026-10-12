'use client';
// Acts in the firm library. The row opens the Act's obligations.
import { DataTable, type DataTableProps } from '@canopy/ui';
import NextLink from 'next/link';
import type { ReactNode } from 'react';

import type { ActItem } from './library-model';

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

const columns: DataTableProps<ActItem>['columns'] = [
  {
    id: 'name',
    header: 'Act',
    accessorFn: (row) => row.name as never,
    meta: { type: 'title', locked: true },
  },
  {
    id: 'shortName',
    header: 'Short name',
    accessorFn: (row) => (row.shortName ?? '') as never,
    meta: { type: 'text' },
  },
  {
    id: 'jurisdiction',
    header: 'Jurisdiction',
    accessorFn: (row) => row.jurisdiction as never,
    meta: { type: 'text' },
  },
  {
    id: 'aliases',
    header: 'Also known as',
    accessorFn: (row) => row.aliases as never,
    meta: { type: 'text' },
    enableSorting: false,
  },
];

export function ActsTable({ items, empty }: { items: ActItem[]; empty: ReactNode }) {
  return (
    <DataTable
      label="Acts"
      toolbar={false}
      columns={columns}
      data={items}
      rowId={(row) => row.id}
      rowLabel={(row) => row.name}
      rowHref={(row) => row.obligationsHref}
      renderLink={renderLink}
      empty={empty}
      countNoun={{ one: 'Act', other: 'Acts' }}
    />
  );
}
