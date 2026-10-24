'use client';
// The operator audit (ADR M15-0001 decision 12): every operator action, newest first, filtered by account, action
// and date, and downloadable for Excel. Filters live in the URL.
import { OperatorAuditAction, type OperatorAuditEvent } from '@canopy/contracts';
import { Button, DateInput, EmptyState, Select } from '@canopy/ui';
import { Download } from 'lucide-react';
import NextLink from 'next/link';
import { useEffect, useState } from 'react';

import { errorMessage, type OperatorClient } from '../api';
import { auditCsv, auditFileName } from '../audit-export';
import { ACTION, formatInstant, todayInIndia } from '../format';
import { useSession } from '../session';
import { useLoad } from '../use-load';
import { cell, Loading, LoadError, PageHeader, Table } from '../ui/parts';

const ALL = 'all';
/** The most rows one download reads, so a runaway export cannot hang the browser. */
export const EXPORT_MAX = 10_000;

export type AuditFilters = {
  action?: OperatorAuditAction;
  accountId?: string;
  from?: string;
  to?: string;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function auditFiltersFrom(search: URLSearchParams): AuditFilters {
  const action = OperatorAuditAction.safeParse(search.get('action'));
  const accountId = search.get('account') ?? '';
  const from = search.get('from') ?? '';
  const to = search.get('to') ?? '';
  return {
    ...(action.success ? { action: action.data } : {}),
    ...(/^[0-9a-f-]{36}$/i.test(accountId) ? { accountId } : {}),
    ...(DATE.test(from) ? { from } : {}),
    ...(DATE.test(to) ? { to } : {}),
  };
}

export function auditFiltersQuery(f: AuditFilters): string {
  const s = new URLSearchParams();
  if (f.action) s.set('action', f.action);
  if (f.accountId) s.set('account', f.accountId);
  if (f.from) s.set('from', f.from);
  if (f.to) s.set('to', f.to);
  const text = s.toString();
  return text ? `?${text}` : '';
}

/**
 * The API's query for the filters. Days are India's: `from` starts at 00:00 IST and `to` covers its whole day, so
 * the instant bound is the next day's 00:00 IST.
 */
export function auditApiQuery(f: AuditFilters) {
  const ist = (date: string) => new Date(`${date}T00:00:00+05:30`).toISOString();
  const nextDay = (date: string) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  };
  return {
    ...(f.action ? { action: f.action } : {}),
    ...(f.accountId ? { accountId: f.accountId } : {}),
    ...(f.from ? { from: ist(f.from) } : {}),
    ...(f.to ? { to: ist(nextDay(f.to)) } : {}),
  };
}

/** Every event the filters match, page by page, up to EXPORT_MAX. */
export async function allEvents(
  api: OperatorClient,
  f: AuditFilters,
): Promise<OperatorAuditEvent[]> {
  const events: OperatorAuditEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.call('listOperatorAudit', {
      query: { ...auditApiQuery(f), limit: '200', ...(cursor ? { cursor } : {}) },
    });
    events.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && events.length < EXPORT_MAX);
  return events.slice(0, EXPORT_MAX);
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function AuditScreen({
  search,
  onFiltersChange,
  save = download,
}: {
  search: URLSearchParams;
  onFiltersChange: (query: string) => void;
  save?: (name: string, text: string) => void;
}) {
  const { api, me } = useSession();
  const filters = auditFiltersFrom(search);
  const key = auditFiltersQuery(filters);
  const [more, setMore] = useState<{ items: OperatorAuditEvent[]; cursor: string | null }>({
    items: [],
    cursor: null,
  });
  const [busy, setBusy] = useState<'more' | 'export' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const page = useLoad(
    () => api.call('listOperatorAudit', { query: { ...auditApiQuery(filters), limit: '50' } }),
    key,
  );
  const names = useLoad(async () => {
    const accounts: Record<string, string> = {};
    let cursor: string | undefined;
    do {
      const p = await api.call('listAccounts', {
        query: { limit: '200', ...(cursor ? { cursor } : {}) },
      });
      for (const a of p.items) accounts[a.id] = a.name;
      cursor = p.nextCursor ?? undefined;
    } while (cursor);
    return accounts;
  }, 'names');

  useEffect(() => {
    setMore({ items: [], cursor: null });
    setActionError(null);
  }, [key]);

  const accounts = names.state === 'ready' ? names.data : {};
  const operators = { [me.operator.id]: me.operator.displayName };
  const update = (next: AuditFilters) => onFiltersChange(auditFiltersQuery(next));

  async function exportAll() {
    setBusy('export');
    setActionError(null);
    try {
      save(
        auditFileName(todayInIndia()),
        auditCsv(await allEvents(api, filters), { accounts, operators }),
      );
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function loadMore(cursor: string) {
    setBusy('more');
    setActionError(null);
    try {
      const next = await api.call('listOperatorAudit', {
        query: { ...auditApiQuery(filters), limit: '50', cursor },
      });
      setMore((m) => ({ items: [...m.items, ...next.items], cursor: next.nextCursor ?? null }));
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  const accountOptions = Object.entries(accounts)
    .sort(([, a], [, b]) => a.localeCompare(b))
    .map(([value, label]) => ({ value, label }));

  const header = (
    <PageHeader
      title="Operator audit"
      description="Everything done from the console, by whom and why. Times are India time."
      actions={
        <Button
          variant="secondary"
          icon={Download}
          loading={busy === 'export'}
          onClick={() => void exportAll()}
        >
          Download for Excel
        </Button>
      }
    />
  );
  const filterBar = (
    <div
      role="search"
      aria-label="Filter the operator audit"
      className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end"
    >
      <Select
        label="Action"
        value={filters.action ?? ALL}
        onValueChange={(v) =>
          update({ ...filters, action: v === ALL ? undefined : (v as OperatorAuditAction) })
        }
        options={[
          { value: ALL, label: 'Any action' },
          ...OperatorAuditAction.options.map((a) => ({ value: a, label: ACTION[a] })),
        ]}
      />
      <Select
        label="Account"
        value={filters.accountId ?? ALL}
        onValueChange={(v) => update({ ...filters, accountId: v === ALL ? undefined : v })}
        options={[{ value: ALL, label: 'Any account' }, ...accountOptions]}
      />
      <DateInput
        label="From"
        value={filters.from ?? null}
        onValueChange={(v) => update({ ...filters, from: v ?? undefined })}
        today={todayInIndia()}
      />
      <DateInput
        label="To"
        value={filters.to ?? null}
        onValueChange={(v) => update({ ...filters, to: v ?? undefined })}
        today={todayInIndia()}
      />
    </div>
  );
  const errorLine = actionError ? (
    <p role="alert" className="mb-3 text-body text-crit-ink">
      {actionError}
    </p>
  ) : null;

  if (page.state === 'loading')
    return (
      <>
        {header}
        {filterBar}
        <Loading label="Loading the audit" />
      </>
    );
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

  return (
    <>
      {header}
      {filterBar}
      {errorLine}
      {items.length === 0 ? (
        <EmptyState
          variant="no-results"
          title="Nothing matches these filters"
          action={{ label: 'Clear filters', onClick: () => update({}) }}
        />
      ) : (
        <Table caption="Operator audit" head={['When', 'Action', 'Account', 'Operator', 'Reason']}>
          {items.map((e) => (
            <tr key={e.id}>
              <td className={cell}>{formatInstant(e.at)}</td>
              <td className={cell}>{ACTION[e.action]}</td>
              <td className={cell}>
                {e.accountId ? (
                  <NextLink
                    href={`/accounts/${e.accountId}`}
                    prefetch={false}
                    className="font-semibold text-forest hover:underline"
                  >
                    {accounts[e.accountId] ?? 'Account'}
                  </NextLink>
                ) : (
                  '—'
                )}
              </td>
              <td className={cell}>
                {e.operatorId === null ? 'System' : (operators[e.operatorId] ?? 'Another operator')}
              </td>
              <td className={`${cell} max-w-[320px] break-words`}>{e.reason ?? '—'}</td>
            </tr>
          ))}
        </Table>
      )}
      {cursor ? (
        <div className="mt-4">
          <Button
            variant="secondary"
            loading={busy === 'more'}
            onClick={() => void loadMore(cursor)}
          >
            Show older entries
          </Button>
        </div>
      ) : null}
    </>
  );
}
