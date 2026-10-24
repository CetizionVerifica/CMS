// The register's calls to the API: pages of rows, bulk approve and the export. Plain functions of an API client, so
// the Server Actions stay thin and the tests can run these against the in-process mock.
import {
  MAX_BULK_ITEMS,
  MAX_PAGE_LIMIT,
  type ErrorCode,
  type InstanceRow,
} from '@canopy/contracts';

import type { FilterOption } from '@canopy/ui';

import { isApiError, type ApiClient, type CallRequest } from '../../../../../../lib/api/client';

export type RegisterPage = { rows: InstanceRow[]; nextCursor: string | null; total?: number };

type ListQuery = NonNullable<CallRequest<'listInstances'>['query']>;

/** One page of the register for an API query string (`apiQueryFromParams`). The first page also asks for the count. */
export async function loadPage(
  api: Pick<ApiClient, 'call'>,
  clientId: string,
  query: string,
  cursor?: string,
): Promise<RegisterPage> {
  const { data } = await api.call('listInstances', {
    params: { clientId },
    query: {
      ...(Object.fromEntries(new URLSearchParams(query)) as ListQuery),
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

export type Facets = {
  departments: FilterOption[];
  acts: FilterOption[];
  units: FilterOption[];
  categories: FilterOption[];
};

const byLabel = (a: FilterOption, b: FilterOption) => a.label.localeCompare(b.label);

/**
 * Choices for the Department, Act, Unit and Category filters: the first page (200) of each list, which covers any real
 * client. The register works without them, so a list that fails just has no choices.
 */
export async function loadFacets(api: Pick<ApiClient, 'call'>, clientId: string): Promise<Facets> {
  const limit = String(MAX_PAGE_LIMIT);
  const params = { clientId };
  const options = <T>(promise: Promise<T[]>, toOption: (item: T) => FilterOption) =>
    promise.then(
      (items) => items.map(toOption).sort(byLabel),
      () => [] as FilterOption[],
    );
  const named = (item: { id: string; name: string }) => ({ value: item.id, label: item.name });
  const [departments, acts, units, categories] = await Promise.all([
    options(
      api.call('listDepartments', { params, query: { limit } }).then((r) => r.data.items),
      named,
    ),
    options(
      api.call('listActs', { query: { limit } }).then((r) => r.data.items),
      (act) => ({ value: act.id, label: act.shortName ?? act.name }),
    ),
    options(
      api.call('listUnits', { params, query: { limit } }).then((r) => r.data.items),
      named,
    ),
    options(
      api.call('listCategories', { query: { limit } }).then((r) => r.data.items),
      named,
    ),
  ]);
  return { departments, acts, units, categories };
}

/** Splits a list into requests the API accepts: bulk endpoints take at most MAX_BULK_ITEMS (200) items. */
export function chunks<T>(items: readonly T[], size = MAX_BULK_ITEMS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export type ApproveItem = { id: string; version: number };

/** Why an item wasn't approved, in words for the person. Keyed by the API's error code (api-conventions.md §4). */
export type SkipReason = 'changed' | 'not-waiting' | 'not-allowed' | 'failed';

export type BulkOutcome = { approved: number; skipped: Partial<Record<SkipReason, number>> };

function reasonFor(code: ErrorCode | 'UNKNOWN'): SkipReason {
  switch (code) {
    case 'STALE_VERSION':
      return 'changed';
    case 'INVALID_TRANSITION':
      return 'not-waiting';
    case 'FORBIDDEN':
    case 'ACCESS_EXPIRED':
    case 'NOT_FOUND':
      return 'not-allowed';
    default:
      return 'failed';
  }
}

function skip(outcome: BulkOutcome, reason: SkipReason, n = 1): void {
  outcome.skipped[reason] = (outcome.skipped[reason] ?? 0) + n;
}

/**
 * Approves the items, MAX_BULK_ITEMS per request, one request after another so the API isn't flooded. Each item
 * carries the version the person saw, so anything changed since then is refused rather than approved blind. A request
 * that fails as a whole counts all of its items as not approved and the rest carry on.
 */
export async function approveItems(
  api: Pick<ApiClient, 'call'>,
  clientId: string,
  items: readonly ApproveItem[],
): Promise<BulkOutcome> {
  const outcome: BulkOutcome = { approved: 0, skipped: {} };
  for (const batch of chunks(items)) {
    try {
      const { data } = await api.call('bulkApprove', {
        params: { clientId },
        body: { items: batch },
      });
      for (const result of data.results) {
        if (result.ok) outcome.approved += 1;
        else skip(outcome, reasonFor(result.error?.code ?? 'UNKNOWN'));
      }
    } catch (error) {
      if (!isApiError(error)) throw error;
      skip(outcome, reasonFor(error.code), batch.length);
    }
  }
  return outcome;
}

/**
 * "Select all N" in the grid: every matching row that is waiting for approval, with its current version, page by page.
 * A view filtered to other workflow states has nothing to approve.
 */
export async function approvableItems(
  api: Pick<ApiClient, 'call'>,
  clientId: string,
  query: string,
): Promise<ApproveItem[]> {
  const params = new URLSearchParams(query);
  const states = params.get('workflowState')?.split(',');
  if (states && !states.includes('SUBMITTED')) return [];
  params.set('workflowState', 'SUBMITTED');
  const items: ApproveItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await loadPage(api, clientId, params.toString(), cursor);
    items.push(...page.rows.map(({ id, version }) => ({ id, version })));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

const SKIP_TEXT: Record<SkipReason, (n: number) => string> = {
  changed: (n) => `${n} changed since you opened the register`,
  'not-waiting': (n) => `${n} ${n === 1 ? 'isn’t' : 'aren’t'} waiting for approval`,
  'not-allowed': (n) => `${n} ${n === 1 ? 'isn’t' : 'aren’t'} yours to approve`,
  failed: (n) => `${n} couldn’t be approved`,
};

const instances = (n: number) => `${n} ${n === 1 ? 'instance' : 'instances'}`;

/** The toast after a bulk approve. */
export function bulkMessage(outcome: BulkOutcome): { tone: 'success' | 'warn'; message: string } {
  const reasons = (Object.keys(SKIP_TEXT) as SkipReason[]).filter((r) => outcome.skipped[r]);
  if (reasons.length === 0) {
    return outcome.approved === 0
      ? { tone: 'warn', message: 'Nothing in this view is waiting for approval.' }
      : { tone: 'success', message: `Approved ${instances(outcome.approved)}.` };
  }
  const parts = reasons.map((r) => SKIP_TEXT[r](outcome.skipped[r]!));
  return {
    tone: 'warn',
    message: `Approved ${instances(outcome.approved)}. Not approved: ${parts.join(', ')}.`,
  };
}

export type ExportState =
  { status: 'pending' } | { status: 'failed' } | { status: 'ready'; url: string };

/** Starts an Excel export of exactly this view (the same filter string the register sends). */
export async function startExport(
  api: Pick<ApiClient, 'call'>,
  clientId: string,
  query: string,
): Promise<string> {
  const { data } = await api.call('createExport', {
    params: { clientId },
    body: { kind: 'REGISTER_XLSX', filters: query },
  });
  return data.id;
}

/** Where an export is. A finished one comes with its download link, which expires in 5 minutes (never logged). */
export async function exportState(api: Pick<ApiClient, 'call'>, id: string): Promise<ExportState> {
  const { data } = await api.call('getExport', { params: { id } });
  if (data.status === 'FAILED') return { status: 'failed' };
  if (data.status !== 'DONE') return { status: 'pending' };
  const { data: signed } = await api.call('exportDownloadUrl', { params: { id } });
  return { status: 'ready', url: signed.url };
}
