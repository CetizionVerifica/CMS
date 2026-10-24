'use client';
// The register grid (MODULES.md M12): filters, search, sort and saved views in the URL; virtualised rows from the
// DataTable; bulk approve and export when the page offers them. It renders what it is given; the page loads the rows.
import type { InstanceRow } from '@canopy/contracts';
import {
  Button,
  DataTable,
  EmptyState,
  FilterBar,
  type BulkAction,
  type FilterDef,
  type FilterOption,
  type LinkRenderer,
} from '@canopy/ui';
import { CheckCheck } from 'lucide-react';
import NextLink from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState, useTransition } from 'react';

import { registerColumns, rowLabel } from '../_lib/columns';
import { DEFAULT_LAYOUT, type GridLayout } from '../_lib/layout';
import {
  CRITICALITY_OPTIONS,
  DUE_FILTER,
  SEARCH_PARAM,
  STATUS_OPTIONS,
  filterValueFromParams,
  sortingFromParams,
  withFilters,
  withSearch,
  withSorting,
} from '../_lib/query';
import { storageKey } from '../_lib/saved-views';
import { useSavedViews } from './useSavedViews';

const renderLink: LinkRenderer = ({ href, children, ...rest }) => (
  <NextLink href={href} {...rest}>
    {children}
  </NextLink>
);

export type RegisterFacets = {
  departments: FilterOption[];
  acts: FilterOption[];
  units: FilterOption[];
  categories: FilterOption[];
};

export type RegisterGridProps = {
  clientId: string;
  personId: string;
  rows: InstanceRow[];
  /** Matching rows on the server, when the API reports it. */
  totalCount?: number;
  facets: RegisterFacets;
  loading?: boolean;
  refetching?: boolean;
  error?: { message: string; retry: () => void; errorId?: string };
  /** Approve the selected rows. Only passed for people who may approve in this client. */
  onBulkApprove?: (ids: string[] | 'all') => void;
  /** Export the current view. */
  onExport?: () => void;
  /** The server has more matching rows than `rows`: a button loads the next page. */
  more?: { loading: boolean; onLoad: () => void };
};

const COUNT_NOUN = { one: 'instance', other: 'instances' };

export function RegisterGrid({
  clientId,
  personId,
  rows,
  totalCount,
  facets,
  loading,
  refetching,
  error,
  onBulkApprove,
  onExport,
  more,
}: RegisterGridProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const search = useMemo(() => new URLSearchParams(params.toString()), [params]);

  // `replace`, not `push`: typing in search or ticking a filter shouldn't add a history entry per keystroke. In a
  // transition, so the current rows stay up with the refetch bar while the server renders the new ones.
  const [navigating, startNavigation] = useTransition();
  const navigate = useCallback(
    (next: URLSearchParams) => {
      const qs = next.toString();
      startNavigation(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
    },
    [router, pathname],
  );

  const filters = useMemo<FilterDef[]>(
    () => [
      {
        key: 'status',
        label: 'Status',
        kind: 'multi',
        display: 'status',
        order: 'given',
        options: STATUS_OPTIONS.map((s) => ({ value: s, label: s })),
      },
      {
        key: 'criticality',
        label: 'Criticality',
        kind: 'multi',
        display: 'criticality',
        order: 'given',
        options: CRITICALITY_OPTIONS.map((c) => ({ value: c, label: c })),
      },
      { key: 'departmentId', label: 'Department', kind: 'multi', options: facets.departments },
      { key: 'actId', label: 'Act', kind: 'multi', options: facets.acts },
      { key: DUE_FILTER, label: 'Due date', kind: 'dateRange' },
      { key: 'unitId', label: 'Unit', kind: 'multi', options: facets.units },
      { key: 'categoryId', label: 'Category', kind: 'multi', options: facets.categories },
    ],
    [facets],
  );

  const [layout, setLayout] = useState<GridLayout>(DEFAULT_LAYOUT);
  const views = useSavedViews(storageKey(personId, clientId), search, navigate, layout, setLayout);

  const bulkActions = useMemo<BulkAction[]>(
    () => (onBulkApprove ? [{ label: 'Approve', icon: CheckCheck, onClick: onBulkApprove }] : []),
    [onBulkApprove],
  );

  const count = totalCount ?? rows.length;
  const qs = search.toString();
  const filtered =
    Object.keys(filterValueFromParams(search)).length > 0 || search.has(SEARCH_PARAM);

  return (
    <div className="flex flex-col gap-3">
      <FilterBar
        filters={filters}
        value={filterValueFromParams(search)}
        onChange={(value) => navigate(withFilters(search, value))}
        search={{
          value: search.get(SEARCH_PARAM) ?? '',
          onChange: (text) => navigate(withSearch(search, text)),
          placeholder: 'Search ID, title or Act',
        }}
        primaryKeys={['status', 'criticality', 'departmentId', 'actId', DUE_FILTER]}
        resultText={
          loading ? undefined : `${count} ${count === 1 ? COUNT_NOUN.one : COUNT_NOUN.other} match`
        }
        resultCount={count}
        disabled={!!error}
      />
      <DataTable<InstanceRow>
        label="Register"
        columns={registerColumns}
        data={rows}
        rowId={(row) => row.id}
        rowLabel={rowLabel}
        rowHref={(row) =>
          `/c/${encodeURIComponent(clientId)}/register/${row.id}${qs ? `?${qs}` : ''}`
        }
        renderLink={renderLink}
        sorting={sortingFromParams(search)}
        onSortingChange={(sorting) => navigate(withSorting(search, sorting))}
        manualSorting
        selection={bulkActions.length > 0 ? { bulkActions } : undefined}
        columnVisibility={layout.visibility}
        columnOrder={layout.order}
        onColumnsChange={(next) => setLayout((prev) => ({ ...prev, ...next }))}
        density={layout.density}
        onDensityChange={(density) => setLayout((prev) => ({ ...prev, density }))}
        loading={loading}
        refetching={refetching || navigating}
        error={error}
        totalCount={count}
        countNoun={COUNT_NOUN}
        views={views}
        onExport={onExport}
        empty={
          filtered ? (
            <EmptyState
              variant="no-results"
              title="No instances match these filters"
              body="Clear a filter or search for something else."
              action={{
                label: 'Clear filters',
                onClick: () => navigate(withSearch(withFilters(search, {}), '')),
              }}
            />
          ) : (
            <EmptyState
              variant="first-use"
              title="Nothing in the register for this period"
              body="Instances appear here once obligations are assigned to this client’s units."
            />
          )
        }
      />
      {more && rows.length > 0 ? (
        <div className="flex flex-wrap items-center justify-center gap-3">
          <span className="text-meta text-muted" role="status">
            Showing {rows.length} of {count}
          </span>
          <Button variant="secondary" size="sm" loading={more.loading} onClick={more.onLoad}>
            Show more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
