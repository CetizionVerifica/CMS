'use client';
// Every account, newest first, filtered by status, kind and name. Filters live in the URL so a view can be shared.
import { AccountKind, AccountStatus, type Account } from '@canopy/contracts';
import { Button, EmptyState, Input, Link, Select } from '@canopy/ui';
import NextLink from 'next/link';
import { useEffect, useState } from 'react';

import { errorMessage } from '../api';
import { formatDate, KIND, STATUS, usageOf } from '../format';
import { useSession } from '../session';
import { useLoad } from '../use-load';
import { AccountStatusPill, cell, Loading, LoadError, PageHeader, Table } from '../ui/parts';

const ALL = 'all';

export type AccountFilters = { status?: AccountStatus; kind?: AccountKind; q?: string };

/** The filters a URL asks for; unknown values are dropped. */
export function filtersFrom(search: URLSearchParams): AccountFilters {
  const status = AccountStatus.safeParse(search.get('status'));
  const kind = AccountKind.safeParse(search.get('kind'));
  const q = search.get('q')?.trim() ?? '';
  return {
    ...(status.success ? { status: status.data } : {}),
    ...(kind.success ? { kind: kind.data } : {}),
    ...(q.length >= 2 ? { q } : {}),
  };
}

export function filtersQuery(filters: AccountFilters): string {
  const search = new URLSearchParams();
  if (filters.status) search.set('status', filters.status);
  if (filters.kind) search.set('kind', filters.kind);
  if (filters.q) search.set('q', filters.q);
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** What the trial or term column says: the trial end, or nothing for an account on a paid term. */
function trialText(account: Account): string {
  return account.trialEndsOn ? `Trial ends ${formatDate(account.trialEndsOn)}` : '—';
}

export function AccountsList({
  search,
  onFiltersChange,
}: {
  search: URLSearchParams;
  onFiltersChange: (query: string) => void;
}) {
  const { api } = useSession();
  const filters = filtersFrom(search);
  const key = filtersQuery(filters);
  const [typed, setTyped] = useState(filters.q ?? '');
  const [more, setMore] = useState<{ items: Account[]; cursor: string | null }>({
    items: [],
    cursor: null,
  });
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const page = useLoad(() => api.call('listAccounts', { query: { ...filters, limit: '50' } }), key);

  useEffect(() => {
    setMore({ items: [], cursor: null });
    setMoreError(null);
  }, [key]);

  const update = (next: AccountFilters) => onFiltersChange(filtersQuery(next));

  async function loadMore(cursor: string) {
    setLoadingMore(true);
    setMoreError(null);
    try {
      const next = await api.call('listAccounts', { query: { ...filters, limit: '50', cursor } });
      setMore((m) => ({ items: [...m.items, ...next.items], cursor: next.nextCursor ?? null }));
    } catch (error) {
      setMoreError(errorMessage(error));
    } finally {
      setLoadingMore(false);
    }
  }

  const header = (
    <PageHeader
      title="Accounts"
      description="Every customer account. Open one to change its plan, status or billing."
      actions={
        <Button asChild>
          <NextLink href="/accounts/new">New account</NextLink>
        </Button>
      }
    />
  );

  const filterBar = (
    <form
      role="search"
      aria-label="Filter accounts"
      className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_200px_200px] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        update({ ...filters, q: typed.trim().length >= 2 ? typed.trim() : undefined });
      }}
    >
      <Input
        label="Name"
        name="q"
        type="search"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        helper="Two letters or more, then Enter."
      />
      <Select
        label="Status"
        value={filters.status ?? ALL}
        onValueChange={(v) =>
          update({ ...filters, status: v === ALL ? undefined : (v as AccountStatus) })
        }
        options={[
          { value: ALL, label: 'Any status' },
          ...AccountStatus.options.map((s) => ({ value: s, label: STATUS[s].label })),
        ]}
      />
      <Select
        label="Kind"
        value={filters.kind ?? ALL}
        onValueChange={(v) =>
          update({ ...filters, kind: v === ALL ? undefined : (v as AccountKind) })
        }
        options={[
          { value: ALL, label: 'Any kind' },
          ...AccountKind.options.map((k) => ({ value: k, label: KIND[k] })),
        ]}
      />
    </form>
  );

  if (page.state === 'loading') {
    return (
      <>
        {header}
        {filterBar}
        <Loading label="Loading accounts" />
      </>
    );
  }
  if (page.state === 'error') {
    return (
      <>
        {header}
        {filterBar}
        <LoadError message={page.message} onRetry={page.reload} />
      </>
    );
  }

  const items = [...page.data.items, ...more.items];
  const cursor = more.items.length > 0 ? more.cursor : page.data.nextCursor;
  const filtered = Boolean(filters.status || filters.kind || filters.q);

  return (
    <>
      {header}
      {filterBar}
      {items.length === 0 ? (
        filtered ? (
          <EmptyState
            variant="no-results"
            title="No account matches these filters"
            action={{ label: 'Clear filters', onClick: () => update({}) }}
          />
        ) : (
          <EmptyState
            variant="first-use"
            title="No accounts yet"
            body="Create the first account; its owner gets an invite to sign in."
            action={{ label: 'New account', href: '/accounts/new' }}
          />
        )
      ) : (
        <Table caption="Accounts" head={['Account', 'Status', 'Plan', 'Users', 'Trial', 'Created']}>
          {items.map((a) => (
            <tr key={a.id}>
              <td className={cell}>
                <Link asChild>
                  <NextLink href={`/accounts/${a.id}`} prefetch={false}>
                    {a.name}
                  </NextLink>
                </Link>
                <div className="text-meta text-muted">{KIND[a.kind]}</div>
              </td>
              <td className={cell}>
                <AccountStatusPill status={a.status} />
              </td>
              <td className={cell}>{a.planCode}</td>
              <td className={cell}>{usageOf(a.usage.users, a.entitlements.limits.users)}</td>
              <td className={cell}>{trialText(a)}</td>
              <td className={cell}>{formatDate(a.createdAt.slice(0, 10))}</td>
            </tr>
          ))}
        </Table>
      )}
      {cursor ? (
        <div className="mt-4 flex flex-col items-start gap-2">
          <Button variant="secondary" loading={loadingMore} onClick={() => void loadMore(cursor)}>
            Show more accounts
          </Button>
          {moreError ? (
            <p role="alert" className="text-body text-crit-ink">
              {moreError}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
