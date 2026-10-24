// The approvals inbox's calls to the API and its rows. Plain functions of an API client, so the Server Actions stay
// thin and the tests can run these against the in-process mock.
import { MAX_PAGE_LIMIT, type InstanceRow } from '@canopy/contracts';
import type { TaskItem } from '@canopy/ui';

import type { ApiClient } from '../../../../../../lib/api/client';

export type ApprovalsPage = { rows: InstanceRow[]; nextCursor: string | null; total?: number };

/**
 * Whose approvals the inbox lists: `mine` is what an APPROVER approves (`approverId=me`); `client` is everything waiting
 * in the client, which a CLIENT_ADMIN may approve (GET /me/approvals' rule, kept to this client).
 */
export type QueueScope = 'mine' | 'client';

/** One page of what waits for approval in a client, oldest due date first. The first page also asks for the count. */
export async function loadQueue(
  api: Pick<ApiClient, 'call'>,
  clientId: string,
  scope: QueueScope,
  cursor?: string,
): Promise<ApprovalsPage> {
  const { data } = await api.call('listInstances', {
    params: { clientId },
    query: {
      workflowState: 'SUBMITTED',
      ...(scope === 'mine' ? { approverId: 'me' } : {}),
      sort: 'dueDate',
      limit: String(MAX_PAGE_LIMIT),
      ...(cursor ? { cursor } : { count: 'true' }),
    },
  });
  return {
    rows: data.items,
    nextCursor: data.nextCursor,
    ...(data.total === undefined ? {} : { total: data.total }),
  };
}

/** The drawer's path for an instance in the inbox, so a row's link opens it over this page. */
export function approvalsHref(clientId: string, instanceId?: string): string {
  const base = `/c/${encodeURIComponent(clientId)}/approvals`;
  return instanceId ? `${base}/${encodeURIComponent(instanceId)}` : base;
}

/** What a row asks for, in words: a done item to approve, or a request to mark it not applicable. */
export function askOf(row: Pick<InstanceRow, 'pendingKind'>): string {
  return row.pendingKind === 'NA' ? 'asks to mark not applicable' : 'marked done';
}

/** A row as the TaskList shows it: the Act, the unit and who sent it, so an approver can tell rows apart. */
export function taskItem(clientId: string, row: InstanceRow): TaskItem {
  return {
    id: row.id,
    title: row.title,
    meta: `${row.actName} · ${row.unitName} · ${row.ownerName} ${askOf(row)}`,
    dueDate: row.dueDate,
    status: row.status,
    ...(row.overdueDays === null ? {} : { days: row.overdueDays }),
    href: approvalsHref(clientId, row.id),
  };
}

/** The instance in a `/c/<client>/approvals/<instance>` path, or null on the inbox itself. */
export function openApprovalId(pathname: string): string | null {
  const match = /\/approvals\/([^/]+)\/?$/.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}
