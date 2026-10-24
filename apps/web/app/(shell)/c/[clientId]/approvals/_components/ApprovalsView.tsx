'use client';
// The approvals inbox's interactive part: the TaskList in approver mode (J/K move, Enter opens, A approves, S sends
// back with a reason), more pages on request, and the instance drawer over the list. Opening, moving and closing the
// drawer only change the path, in the browser, as on the register.
import type { InstanceDetail, InstanceRow } from '@canopy/contracts';
import { Button, ConfirmDialog, formatNumber, TaskList, toast } from '@canopy/ui';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';

import { InstanceDrawer } from '../../register/_components/InstanceDrawer';
import { rowOf } from '../../register/_lib/instance-api';
import { runInstanceAction } from '../../register/instance-actions';
import { loadMoreApprovals } from '../actions';
import {
  approvalsHref,
  openApprovalId,
  taskItem,
  type ApprovalsPage,
  type QueueScope,
} from '../_lib/approvals-api';

export type ApprovalsViewProps = {
  clientId: string;
  personId: string;
  scope: QueueScope;
  page: ApprovalsPage;
  /** GET /me/approvals' count: what waits for the person across every client they approve in. */
  waitingEverywhere: number;
  /** FIRM_ADMIN, CONSULTANT or CLIENT_ADMIN in this client: may remove any instance's evidence. */
  canManage: boolean;
  /** The client's IANA time zone. */
  timeZone: string;
};

/** Answers that mean the row moved on since the page loaded: the list is re-read so the person sees it as it is. */
const MOVED_ON = new Set(['STALE_VERSION', 'INVALID_TRANSITION', 'NOT_FOUND']);

const plural = (n: number, one: string, many: string) =>
  `${formatNumber(n)} ${n === 1 ? one : many}`;

/** The count line under the header: here, and across every client when more wait elsewhere. */
export function waitingLine(here: number, everywhere: number, scope: QueueScope): string {
  const line = `${plural(here, 'item', 'items')} waiting for ${scope === 'mine' ? 'your ' : ''}approval here`;
  return everywhere > here
    ? `${line}, ${formatNumber(everywhere)} across all your clients.`
    : `${line}.`;
}

export function ApprovalsView({
  clientId,
  personId,
  scope,
  page,
  waitingEverywhere,
  canManage,
  timeZone,
}: ApprovalsViewProps) {
  const router = useRouter();
  const pathname = usePathname();
  // Rows loaded with "Show more" stay until the server sends a new first page (after a refresh).
  const [rows, setRows] = useState(page.rows);
  const [nextCursor, setNextCursor] = useState(page.nextCursor);
  const [total, setTotal] = useState(page.total ?? page.rows.length);
  const [seen, setSeen] = useState(page);
  if (seen !== page) {
    setSeen(page);
    setRows(page.rows);
    setNextCursor(page.nextCursor);
    setTotal(page.total ?? page.rows.length);
  }
  const [loadingMore, setLoadingMore] = useState(false);
  const [processing, setProcessing] = useState<string[]>([]);
  const [sendingBack, setSendingBack] = useState<InstanceRow | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const more = await loadMoreApprovals(clientId, scope, nextCursor);
      setRows((prev) => [...prev, ...more.rows.filter((r) => !prev.some((p) => p.id === r.id))]);
      setNextCursor(more.nextCursor);
    } catch {
      toast({ tone: 'error', message: 'More items didn’t load. Try again.' });
    } finally {
      setLoadingMore(false);
    }
  }, [clientId, nextCursor, scope]);

  /** Takes a row out of the list once it has been decided, and refreshes the page so the badge catches up. */
  const settle = useCallback(
    (id: string) => {
      setRows((prev) => prev.filter((r) => r.id !== id));
      setTotal((n) => Math.max(0, n - 1));
      router.refresh();
    },
    [router],
  );

  const decide = useCallback(
    async (
      row: InstanceRow,
      kind: 'APPROVE' | 'SEND_BACK',
      reason?: string,
    ): Promise<'done' | 'moved' | 'failed'> => {
      setProcessing((prev) => [...prev, row.id]);
      try {
        const result = await runInstanceAction(
          row.id,
          kind === 'APPROVE'
            ? { kind, version: row.version }
            : { kind, version: row.version, reason: reason ?? '' },
        );
        if (result.ok) {
          settle(row.id);
          toast({
            tone: 'success',
            message:
              kind === 'SEND_BACK'
                ? `Sent “${row.title}” back to ${row.ownerName}.`
                : row.pendingKind === 'NA'
                  ? `Approved “${row.title}” as not applicable.`
                  : `Approved “${row.title}”.`,
          });
          return 'done';
        }
        toast({ tone: 'error', message: result.message });
        if (!MOVED_ON.has(result.code)) return 'failed';
        router.refresh();
        return 'moved';
      } catch {
        toast({ tone: 'error', message: 'That didn’t go through. Try again.' });
        return 'failed';
      } finally {
        setProcessing((prev) => prev.filter((id) => id !== row.id));
      }
    },
    [router, settle],
  );

  const find = (id: string) => rows.find((r) => r.id === id);

  // The drawer follows the path: `/approvals/<id>` shows that instance. A row's link opens it with pushState, so the
  // list and its focus stay; Back closes it again.
  const openId = openApprovalId(pathname);
  const index = openId ? rows.findIndex((r) => r.id === openId) : -1;
  const showInstance = (id: string, replace = false) => {
    const href = approvalsHref(clientId, id);
    if (replace) window.history.replaceState(null, '', href);
    else window.history.pushState(null, '', href);
  };
  const sibling = (step: number) => {
    const row = index >= 0 ? rows[index + step] : undefined;
    return row ? () => showInstance(row.id, true) : undefined;
  };

  // A decision in the drawer keeps its row while the drawer is open, so previous and next still work; when it closes,
  // rows no longer waiting leave the list and the page is refreshed.
  const changedInDrawer = useRef(false);
  const onChanged = useCallback((detail: InstanceDetail) => {
    changedInDrawer.current = true;
    const row = rowOf(detail);
    setRows((prev) => prev.map((r) => (r.id === row.id ? row : r)));
  }, []);
  useEffect(() => {
    if (openId === null && changedInDrawer.current) {
      changedInDrawer.current = false;
      const decided = rows.filter((r) => r.workflowState !== 'SUBMITTED').length;
      if (decided > 0) {
        setRows((prev) => prev.filter((r) => r.workflowState === 'SUBMITTED'));
        setTotal((n) => Math.max(0, n - decided));
      }
      router.refresh();
    }
  }, [openId, rows, router]);

  /**
   * When the dialog closes, focus goes back to the row it was opened from, or after a send back to the row that took
   * its place (the next one, else the last), or to the count line when the list is empty.
   */
  const sendBackIndex = useRef(0);
  const nextFocus = () => {
    const links = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-task-link]') ?? [])];
    return (
      links[Math.min(sendBackIndex.current, links.length - 1)] ??
      listRef.current?.querySelector<HTMLElement>('h2') ??
      null
    );
  };

  return (
    <div ref={listRef} className="flex max-w-3xl flex-col gap-3">
      <h2 tabIndex={-1} className="text-body text-muted outline-none">
        {waitingLine(total, waitingEverywhere, scope)}
      </h2>
      <TaskList
        label="Waiting for approval"
        mode="approver"
        items={rows.map((r) => taskItem(clientId, r))}
        processingIds={processing}
        onApprove={(id) => {
          const row = find(id);
          if (row) void decide(row, 'APPROVE');
        }}
        onSendBack={(id) => {
          sendBackIndex.current = Math.max(
            0,
            rows.findIndex((r) => r.id === id),
          );
          setSendingBack(find(id) ?? null);
        }}
        renderLink={({ href, children, ...rest }) => (
          <a
            {...rest}
            href={href}
            onClick={(e: MouseEvent<HTMLAnchorElement>) => {
              // A plain click opens the drawer here; a new tab or window follows the link.
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              window.history.pushState(null, '', href);
            }}
          >
            {children}
          </a>
        )}
      />
      {nextCursor ? (
        <Button className="self-start" loading={loadingMore} onClick={() => void loadMore()}>
          Show more
        </Button>
      ) : null}
      <InstanceDrawer
        instanceId={openId}
        fallbackTitle={index >= 0 ? rows[index]!.title : undefined}
        timeZone={timeZone}
        canManage={canManage}
        personId={personId}
        onClose={() => window.history.pushState(null, '', approvalsHref(clientId))}
        backLabel="Back to approvals"
        onPrev={sibling(-1)}
        onNext={sibling(1)}
        onChanged={onChanged}
      />
      <ConfirmDialog
        open={sendingBack !== null}
        onOpenChange={(open) => {
          if (!open) setSendingBack(null);
        }}
        title={sendingBack ? `Send back to ${sendingBack.ownerName}?` : 'Send back?'}
        body="The owner sees your reason and works on it again. It counts as open until it is submitted again."
        confirmLabel="Send back"
        tone="danger"
        reason={{ label: 'Reason', required: true, maxLength: 2000 }}
        returnFocusTo={nextFocus}
        onConfirm={async (reason) => {
          if (!sendingBack) return;
          // The dialog stays open on a failure, keeping the reason; it closes when the row has moved on.
          if ((await decide(sendingBack, 'SEND_BACK', reason)) === 'failed')
            throw new Error('Not sent back');
        }}
      />
    </div>
  );
}
