'use client';
// The evidence vault's interactive part: filters in the URL (the server re-renders the first page when they change),
// more pages on request, and opening a file through a signed URL fetched on the click.
import type { EvidenceView, ScanStatus } from '@canopy/contracts';
import {
  Button,
  DataTable,
  EmptyState,
  FilterBar,
  formatTimestamp,
  toast,
  type DataTableProps,
  type FilterDef,
  type FilterValue,
} from '@canopy/ui';
import { Download } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useMemo, useState, useTransition, type ReactNode } from 'react';

import { fileSize, openEvidence, SCAN_TEXT } from '../../register/_lib/evidence-files';
import { evidenceDownload } from '../../register/instance-actions';
import { loadMoreEvidence } from '../actions';
import { instanceHref, type VaultLookups, type VaultPage } from '../_lib/vault-api';

export type EvidenceVaultProps = {
  clientId: string;
  /** The API query the first page was loaded with (`vaultQuery`); it is also the page's URL query. */
  query: string;
  page: VaultPage;
  lookups: VaultLookups;
  /** The client's IANA time zone, for upload times. */
  timeZone: string;
};

const SCAN_OPTIONS = (['CLEAN', 'PENDING', 'INFECTED', 'FAILED'] as const).map((value) => ({
  value,
  label: SCAN_TEXT[value],
}));
const COUNT_NOUN = { one: 'file', other: 'files' };

type Column = DataTableProps<EvidenceView>['columns'][number];
/** The roving tab stop DataTable gives each row's controls. */
type RowFocus = { rowTabIndex?: (row: unknown) => number };

/** The URL's filters as the FilterBar shows them. */
export function filterValue(search: URLSearchParams): Record<string, FilterValue> {
  const value: Record<string, FilterValue> = {};
  for (const key of ['scanStatus', 'unitId']) {
    const csv = search.get(key);
    if (csv) value[key] = csv.split(',');
  }
  const from = search.get('uploadedFrom') ?? undefined;
  const to = search.get('uploadedTo') ?? undefined;
  if (from || to) value.uploaded = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  return value;
}

/** The URL for the FilterBar's choices, keeping the search text. */
export function withFilters(
  search: URLSearchParams,
  value: Record<string, FilterValue>,
): URLSearchParams {
  const next = new URLSearchParams();
  const q = search.get('q');
  if (q) next.set('q', q);
  for (const key of ['scanStatus', 'unitId']) {
    const list = value[key];
    if (Array.isArray(list) && list.length > 0) next.set(key, list.join(','));
  }
  const range = value.uploaded;
  if (range && !Array.isArray(range)) {
    if (range.from) next.set('uploadedFrom', range.from);
    if (range.to) next.set('uploadedTo', range.to);
  }
  return next;
}

export function EvidenceVault({ clientId, query, page, lookups, timeZone }: EvidenceVaultProps) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useMemo(() => new URLSearchParams(query), [query]);

  // Rows loaded with "Show more" belong to one query; a new first page from the server starts again.
  const [rows, setRows] = useState(page.rows);
  const [nextCursor, setNextCursor] = useState(page.nextCursor);
  const [seen, setSeen] = useState(page);
  if (seen !== page) {
    setSeen(page);
    setRows(page.rows);
    setNextCursor(page.nextCursor);
  }
  const [loadingMore, setLoadingMore] = useState(false);

  const [navigating, startNavigation] = useTransition();
  const navigate = useCallback(
    (next: URLSearchParams) => {
      const qs = next.toString();
      startNavigation(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
    },
    [router, pathname],
  );

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const more = await loadMoreEvidence(clientId, query, nextCursor);
      setRows((prev) => [...prev, ...more.rows.filter((r) => !prev.some((p) => p.id === r.id))]);
      setNextCursor(more.nextCursor);
    } catch {
      toast({ tone: 'error', message: 'More files didn’t load. Try again.' });
    } finally {
      setLoadingMore(false);
    }
  }, [clientId, nextCursor, query]);

  const open = useCallback(async (evidence: EvidenceView) => {
    const failure = await openEvidence(evidence.id, evidenceDownload);
    if (failure) toast({ tone: 'error', message: failure });
  }, []);

  const filters = useMemo<FilterDef[]>(
    () => [
      {
        key: 'scanStatus',
        label: 'Virus check',
        kind: 'multi',
        options: SCAN_OPTIONS,
        order: 'given',
      },
      { key: 'unitId', label: 'Unit', kind: 'multi', options: lookups.units },
      { key: 'uploaded', label: 'Uploaded', kind: 'dateRange' },
    ],
    [lookups.units],
  );

  const columns = useMemo<Column[]>(
    () =>
      [
        {
          id: 'fileName',
          header: 'File',
          accessorFn: (e: EvidenceView) => ({ title: e.fileName, sub: fileSize(e.sizeBytes) }),
          meta: { type: 'title', label: 'File' },
          enableSorting: false,
        },
        {
          id: 'createdAt',
          header: 'Uploaded',
          accessorFn: (e: EvidenceView) => formatTimestamp(e.createdAt, timeZone),
          meta: { type: 'text', label: 'Uploaded' },
          enableSorting: false,
        },
        {
          id: 'uploadedBy',
          header: 'Added by',
          accessorFn: (e: EvidenceView) => ({ name: lookups.names[e.uploadedById] ?? 'Someone' }),
          meta: { type: 'person', label: 'Added by' },
          enableSorting: false,
        },
        {
          id: 'scanStatus',
          header: 'Virus check',
          accessorFn: (e: EvidenceView) => SCAN_TEXT[e.scanStatus],
          meta: { type: 'text', label: 'Virus check' },
          enableSorting: false,
        },
        {
          id: 'open',
          header: 'Open',
          meta: { type: 'actions', label: 'Open' },
          enableSorting: false,
          cell: (ctx: {
            row: { original: EvidenceView };
            table: { options: { meta?: unknown } };
          }) => {
            const evidence = ctx.row.original;
            if (evidence.scanStatus !== ('CLEAN' satisfies ScanStatus)) return null;
            const focus = ctx.table.options.meta as RowFocus | undefined;
            return (
              <Button
                size="sm"
                variant="ghost"
                icon={Download}
                tabIndex={focus?.rowTabIndex?.(ctx.row) ?? 0}
                aria-label={`Open ${evidence.fileName}`}
                onClick={() => void open(evidence)}
              >
                Open
              </Button>
            );
          },
        },
      ] as Column[],
    [lookups.names, open, timeZone],
  );

  const filtered = query !== '';
  const count = page.total ?? rows.length;
  const renderLink = ({ href, children, ...rest }: { href: string; children?: ReactNode }) => (
    <Link href={href} {...rest}>
      {children}
    </Link>
  );

  return (
    <div className="flex flex-col gap-3">
      <FilterBar
        filters={filters}
        value={filterValue(search)}
        onChange={(value) => navigate(withFilters(search, value))}
        search={{
          value: search.get('q') ?? '',
          onChange: (text) => {
            const next = new URLSearchParams(search);
            if (text) next.set('q', text);
            else next.delete('q');
            navigate(next);
          },
          placeholder: 'Search file names',
        }}
        primaryKeys={['scanStatus', 'unitId', 'uploaded']}
        resultText={`${count} ${count === 1 ? COUNT_NOUN.one : COUNT_NOUN.other} match`}
        resultCount={count}
      />
      <DataTable<EvidenceView>
        label="Evidence"
        columns={columns}
        data={rows}
        rowId={(e) => e.id}
        rowLabel={(e) => e.fileName}
        rowHref={(e) => instanceHref(clientId, e.instanceId)}
        renderLink={renderLink}
        refetching={navigating}
        totalCount={count}
        countNoun={COUNT_NOUN}
        empty={
          filtered ? (
            <EmptyState
              variant="no-results"
              title="No files match these filters"
              action={{ label: 'Clear filters', onClick: () => navigate(new URLSearchParams()) }}
            />
          ) : (
            <EmptyState
              variant="first-use"
              title="No evidence yet"
              body="Files attached to instances show here."
            />
          )
        }
      />
      {nextCursor ? (
        <Button className="self-start" loading={loadingMore} onClick={() => void loadMore()}>
          Show more
        </Button>
      ) : null}
    </div>
  );
}
