'use client';
// A list of ISO records as the design system's table. A row's link keeps the list's filters and opens the record (a
// drawer named in the URL, or the record's own page), so the back button closes it.
import { DataTable, type DataTableProps } from '@canopy/ui';
import NextLink from 'next/link';
import type { ReactNode } from 'react';

const renderLink = ({
  href,
  children,
  ...rest
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) => (
  <NextLink href={href} scroll={false} prefetch={false} {...rest}>
    {children}
  </NextLink>
);

export function IsoTable<T>(
  props: Omit<DataTableProps<T>, 'renderLink' | 'toolbar'> & { rowHref: (row: T) => string },
) {
  return <DataTable {...props} toolbar={false} renderLink={renderLink} />;
}
