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
import { pinToLoaded, type ApproveItem, type RegisterPage } from '../_lib/register-api';
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

  // "Select all N" asks first: the dialog names how many rows are waiting now, and Approve sends exactly those.
  const [confirmAll, setConfirmAll] = useState<ApproveItem[] | null>(null);

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
        if (ids !== 'all') {
          await send(
            ids.flatMap((id) => {
              const version = versions.get(id);
              return version === undefined ? [] : [{ id, version }];
            }),
          );
          return;
        }
        let waiting: ApproveItem[];
        try {
          waiting = pinToLoaded(await waitingRows(clientId, loaded.query), versions);
        } catch {
          toast({ tone: 'error', message: 'The rows to approve didn’t load. Try again.' });
          return;
        }
        if (waiting.length === 0) {
          toast({ tone: 'warn', message: 'Nothing in this view is waiting for approval.' });
          return;
        }
        setConfirmAll(waiting);
      } finally {
        setBusy(false);
      }
    },
    [busy, clientId, loaded, send],
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

  const count = confirmAll?.length ?? 0;
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
        open={confirmAll !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmAll(null);
        }}
        title={`Approve ${formatNumber(count)} ${count === 1 ? 'instance' : 'instances'}?`}
        body={`${count === 1 ? 'This is the one instance' : `These are all ${formatNumber(count)} instances`} in this view waiting for your approval. Any that change before you confirm are left as they are.`}
        confirmLabel="Approve"
        onConfirm={() => send(confirmAll ?? [])}
      />
    </>
  );
}
