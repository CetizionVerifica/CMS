'use client';
// The register page's interactive part: the grid with the rows the server loaded, more pages on request, bulk approve
// and export through the Server Actions, and the instance drawer. The server re-renders the first page whenever the
// URL's query changes; opening, moving and closing the drawer only change the path, in the browser.
import type { InstanceDetail, InstanceRow } from '@canopy/contracts';
import { ConfirmDialog, formatNumber, toast } from '@canopy/ui';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

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
import { rowOf } from '../_lib/instance-api';
import { InstanceDrawer } from './InstanceDrawer';
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
  /** FIRM_ADMIN, CONSULTANT or CLIENT_ADMIN in this client: may remove any instance's evidence. */
  canManage: boolean;
  /** The client's IANA time zone. */
  timeZone: string;
};

/** How often, and how many times, the page asks whether an export is ready before giving up. */
export const EXPORT_POLL_MS = 1000;
export const EXPORT_POLL_TRIES = 60;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Loaded = { query: string; rows: InstanceRow[]; nextCursor: string | null };

/** The instance in a `/c/<client>/register/<instance>` path, or null on the register itself. */
export function openInstanceId(pathname: string): string | null {
  const match = /\/register\/([^/]+)\/?$/.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

export function RegisterView({
  clientId,
  personId,
  query,
  page,
  facets,
  canApprove,
  canExport,
  canManage,
  timeZone,
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

  // The drawer follows the path: `/register/<id>` shows that instance. A row opens it with pushState, so the rows,
  // the scroll position and "Show more" stay as they are; Back closes it again.
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const openId = openInstanceId(pathname);
  const registerPath = `/c/${encodeURIComponent(clientId)}/register`;
  const withQuery = (path: string) => {
    const qs = search.toString();
    return qs ? `${path}?${qs}` : path;
  };
  const showInstance = (id: string, replace = false) => {
    const href = withQuery(`${registerPath}/${encodeURIComponent(id)}`);
    if (replace) window.history.replaceState(null, '', href);
    else window.history.pushState(null, '', href);
  };
  const index = openId ? loaded.rows.findIndex((r) => r.id === openId) : -1;
  const sibling = (step: number) => {
    const row = index >= 0 ? loaded.rows[index + step] : undefined;
    return row ? () => showInstance(row.id, true) : undefined;
  };

  // A change in the drawer shows in its row at once; the rest of the page (counts, badges) is refreshed from the
  // server when the drawer closes, so nothing behind it reloads while the person works.
  const changedInDrawer = useRef(false);
  const onChanged = useCallback((detail: InstanceDetail) => {
    changedInDrawer.current = true;
    const row = rowOf(detail);
    setLoaded((prev) => ({ ...prev, rows: prev.rows.map((r) => (r.id === row.id ? row : r)) }));
  }, []);
  useEffect(() => {
    if (openId === null && changedInDrawer.current) {
      changedInDrawer.current = false;
      router.refresh();
    }
  }, [openId, router]);

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
        onOpenRow={(href) => window.history.pushState(null, '', href)}
      />
      <InstanceDrawer
        instanceId={openId}
        fallbackTitle={index >= 0 ? loaded.rows[index]!.title : undefined}
        timeZone={timeZone}
        canManage={canManage}
        personId={personId}
        onClose={() => window.history.pushState(null, '', withQuery(registerPath))}
        onPrev={sibling(-1)}
        onNext={sibling(1)}
        onChanged={onChanged}
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
