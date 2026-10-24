import type { AuditEvent, Person } from '@canopy/contracts';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';

import { isApiError, type ApiClient } from '../../../../../lib/api/client';
import { serverApi } from '../../../../../lib/api/server';
import { NoPermission, PageHeader } from '../../../../../lib/patterns';
import { routeByPath, visibleTo } from '../../../../../lib/routes';
import { homeHref } from '../../../../../lib/shell/model';
import { loadShell } from '../../../../../lib/shell/server';
import { redirectIfSignedOut } from '../overview/signed-out';
import { AuditFilterBar } from './AuditFilterBar';
import { AuditTable } from './AuditTable';
import { auditRows, kindsFrom } from './audit-model';

type Props = {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { clientId } = await params;
  const client = (await loadShell()).clients.find((c) => c.id === clientId);
  return { title: ['Audit trail', client?.name].filter(Boolean).join(' · ') };
}

const PAGE_SIZE = '50';

function first(value: string | string[] | undefined): string | null {
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

/** Display names by person id: the client's people, and the firm's staff for firm users. A failed list names no one. */
async function namesFor(api: ApiClient, clientId: string, firmUser: boolean) {
  const lists: Promise<Person[]>[] = [
    api
      .call('listClientPeople', { params: { clientId }, query: { limit: '200' } })
      .then(({ data }) => data.items),
  ];
  if (firmUser) {
    lists.push(
      api.call('listFirmPeople', { query: { limit: '200' } }).then(({ data }) => data.items),
    );
  }
  const people = (await Promise.all(lists.map((list) => list.catch(() => [])))).flat();
  return Object.fromEntries(people.map((p) => [p.id, p.displayName]));
}

// The client's audit trail (MODULES.md M13 "reports and audit pages"), newest first, 50 events a page. The events
// are M7's, written in the same transaction as each change; this page only reads and words them.
export default async function AuditPage({ params, searchParams }: Props) {
  const { clientId } = await params;
  const model = await loadShell();
  const client = model.clients.find((c) => c.id === clientId);
  if (!client) notFound();
  if (!visibleTo(routeByPath('audit'), model.roles.byClient[clientId] ?? [])) {
    return (
      <NoPermission
        what="the audit trail"
        backHref={`/c/${clientId}/overview`}
        backLabel="Go to overview"
      />
    );
  }

  const search = await searchParams;
  const { kinds, actions } = kindsFrom(first(search.kind));
  const cursor = first(search.cursor);
  const api = await serverApi();

  let page: { items: AuditEvent[]; nextCursor: string | null; total?: number | null };
  let names: Record<string, string>;
  try {
    [page, names] = await Promise.all([
      api
        .call('clientAudit', {
          params: { clientId },
          query: {
            limit: PAGE_SIZE,
            count: 'true',
            ...(actions.length > 0 ? { action: actions.join(',') } : {}),
            ...(cursor ? { cursor } : {}),
          },
        })
        .then(({ data }) => data),
      namesFor(api, clientId, model.isFirmUser),
    ]);
  } catch (error) {
    await redirectIfSignedOut(error);
    if (isApiError(error, 'FORBIDDEN', 'ACCESS_EXPIRED')) {
      return (
        <NoPermission what="the audit trail" backHref={homeHref(model)} backLabel="Go to home" />
      );
    }
    throw error;
  }

  const rows = auditRows(page.items, names);
  const total = typeof page.total === 'number' ? page.total : null;
  const count =
    total === null
      ? `${rows.length} ${rows.length === 1 ? 'event' : 'events'} on this page`
      : `${total} ${total === 1 ? 'event' : 'events'}`;
  const next = new URLSearchParams();
  if (kinds.length > 0) next.set('kind', kinds.join(','));
  const restart = next.toString();
  if (page.nextCursor) next.set('cursor', page.nextCursor);
  const base = `/c/${clientId}/audit`;

  return (
    <>
      <PageHeader
        title="Audit trail"
        description="Every change to this client's compliance records and setup, newest first. Entries can't be changed or removed."
      />
      <AuditFilterBar kinds={kinds} resultText={count} resultCount={rows.length} />
      <p className="mb-2 text-meta text-muted">{count}</p>
      <AuditTable
        rows={rows}
        timeZone={client.timeZone}
        empty={
          <p className="p-4 text-body text-muted">
            {kinds.length > 0 ? 'No changes of this kind yet.' : 'Nothing has changed yet.'}
          </p>
        }
      />
      <div className="mt-3 flex gap-4">
        {cursor ? (
          <NextLink
            href={restart ? `${base}?${restart}` : base}
            className="text-body text-forest underline"
          >
            Newest first
          </NextLink>
        ) : null}
        {page.nextCursor ? (
          <NextLink href={`${base}?${next.toString()}`} className="text-body text-forest underline">
            Older entries
          </NextLink>
        ) : null}
      </div>
    </>
  );
}
