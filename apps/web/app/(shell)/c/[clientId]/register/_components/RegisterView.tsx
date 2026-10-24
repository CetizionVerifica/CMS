'use client';
// The register page's interactive part: the grid with the rows the server loaded, more pages on request, bulk approve
// and export through the Server Actions. The server re-renders the first page whenever the URL changes.
import type { InstanceRow } from '@canopy/contracts';
import { ConfirmDialog, formatNumber, toast } from '@canopy/ui';
import { useCallback, useState } from 'react';

import {
  bulkApproveRows,
  loadMoreRows,
  registerExportState,
  startRegisterExport,
  waitingRows,
} from '../actions';
import {
  MAX_APPROVE_AT_ONCE,
  pinToLoaded,
  type ApproveItem,
  type RegisterPage,
} from '../_lib/register-api';
import { RegisterGrid, type RegisterFacets } from './RegisterGrid';

export type RegisterViewProps = {
  clientId: string;
  personId: string;
  /** The API query the first page was loaded with; later pages and "select all" use the same one. */
  query: string;
  page: RegisterPage;
  facets: RegisterFacets;
  canApprove: boolean;
  canExport: boolean;
};

/** How often, and how many times, the page asks whether an export is ready before giving up. */
export const EXPORT_POLL_MS = 1000;
export const EXPORT_POLL_TRIES = 60;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Loaded = { query: string; rows: InstanceRow[]; nextCursor: string | null };

export function RegisterView({
  clientId,
  personId,
  query,
  page,
  facets,
  canApprove,
  canExport,
}: RegisterViewProps) {
  // Rows loaded with "Show more" belong to one query; a new query (the URL changed) starts again from its first page.
  const [loaded, setLoaded] = useState<Loaded>({ query, ...page });
  const [seen, setSeen] = useState(page);
  if (seen !== page) {
    setSeen(page);
    setLoaded({ query, ...page });
  }
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadMore = useCallback(async () => {
    if (!loaded.nextCursor) return;
    setLoadingMore(true);
    try {
      const next = await loadMoreRows(clientId, loaded.query, loaded.nextCursor);
      setLoaded((prev) =>
        prev.query === loaded.query
          ? { ...prev, rows: [...prev.rows, ...next.rows], nextCursor: next.nextCursor }
          : prev,
      );
    } catch {
      toast({ tone: 'error', message: 'More rows didn’t load. Try again.' });
    } finally {
      setLoadingMore(false);
    }
  }, [clientId, loaded]);

  // Every bulk approve asks first, naming how many rows it will approve; Approve then sends exactly those, each at the
  // version the person saw. "Select all N" lists the waiting rows on the server before asking.
  const [confirm, setConfirm] = useState<{ items: ApproveItem[]; all: boolean } | null>(null);

  const send = useCallback(
    async (items: ApproveItem[]) => {
      try {
        toast(await bulkApproveRows(clientId, items));
      } catch {
        toast({ tone: 'error', message: 'The approvals didn’t go through. Try again.' });
      }
    },
    [clientId],
  );

  const approve = useCallback(
    async (ids: string[] | 'all') => {
      if (busy) return;
      setBusy(true);
      try {
        const versions = new Map(loaded.rows.map((r) => [r.id, r.version]));
        let items: ApproveItem[];
        if (ids === 'all') {
          try {
            items = pinToLoaded(await waitingRows(clientId, loaded.query), versions);
          } catch {
            toast({ tone: 'error', message: 'The rows to approve didn’t load. Try again.' });
            return;
          }
        } else {
          items = ids.flatMap((id) => {
            const version = versions.get(id);
            return version === undefined ? [] : [{ id, version }];
          });
        }
        if (items.length === 0) {
          toast({ tone: 'warn', message: 'Nothing in this view is waiting for approval.' });
          return;
        }
        if (items.length > MAX_APPROVE_AT_ONCE) {
          toast({
            tone: 'warn',
            message: `More than ${formatNumber(MAX_APPROVE_AT_ONCE)} instances are selected. Narrow the filters to approve up to ${formatNumber(MAX_APPROVE_AT_ONCE)} at a time.`,
          });
          return;
        }
        setConfirm({ items, all: ids === 'all' });
      } finally {
        setBusy(false);
      }
    },
    [busy, clientId, loaded],
  );

  const exportView = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      toast({ tone: 'info', message: 'Preparing your Excel export…' });
      const id = await startRegisterExport(clientId, loaded.query);
      for (let i = 0; i < EXPORT_POLL_TRIES; i++) {
        const state = await registerExportState(id);
        if (state.status === 'ready') {
          window.location.assign(state.url);
          return;
        }
        if (state.status === 'failed') break;
        await wait(EXPORT_POLL_MS);
      }
      toast({ tone: 'error', message: 'The export didn’t finish. Try again.' });
    } catch {
      toast({ tone: 'error', message: 'The export didn’t start. Try again.' });
    } finally {
      setBusy(false);
    }
  }, [busy, clientId, loaded.query]);

  const count = confirm?.items.length ?? 0;
  const instances = `${formatNumber(count)} ${count === 1 ? 'instance' : 'instances'}`;
  return (
    <>
      <RegisterGrid
        clientId={clientId}
        personId={personId}
        rows={loaded.rows}
        totalCount={page.total}
        facets={facets}
        refetching={busy}
        onBulkApprove={canApprove ? (ids) => void approve(ids) : undefined}
        onExport={canExport ? () => void exportView() : undefined}
        more={
          loaded.nextCursor ? { loading: loadingMore, onLoad: () => void loadMore() } : undefined
        }
      />
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={`Approve ${instances}?`}
        body={
          confirm?.all
            ? `${count === 1 ? 'This is the one instance' : `These are all ${instances}`} in this view waiting for approval. Any that change before you confirm are left as they are.`
            : `Approves the ${count === 1 ? 'selected instance' : `${instances} you selected`} as you see ${count === 1 ? 'it' : 'them'}. Any that changed since are left as they are.`
        }
        confirmLabel="Approve"
        onConfirm={() => send(confirm?.items ?? [])}
      />
    </>
  );
}
