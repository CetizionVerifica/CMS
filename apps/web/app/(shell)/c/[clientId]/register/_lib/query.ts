// The register's state lives in the URL (apps/web/CLAUDE.md): filters, search and sort use the API's own query names
// (api-conventions.md §3), so a saved view, a dashboard link and an export share one filter language. Two exceptions,
// because the shell's period picker already owns `q` and `m` (lib/period.ts): free-text search is `search` in the URL
// and `q` in the API query. The period reaches the API through lib/period.ts's `periodApiQuery`: a whole FY as `fy`,
// a quarter or month as `dueFrom`/`dueTo` (ADR M12-0001).
import {
  Criticality,
  DerivedStatus,
  REGISTER_SORT_FIELDS,
  RegisterQuery,
  registerFilterShape,
} from '@canopy/contracts';
import type { DateRange, FilterValue } from '@canopy/ui';

import {
  periodApiQuery,
  periodFromParams,
  type Period,
  type PeriodApiQuery,
} from '../../../../../../lib/period';
import { SOURCE_PARAM, sourceFromParams, sourceOfTicks, withSource } from './source';

type Params = { get(name: string): string | null; getAll?(name: string): string[] };
type SortingState = { id: string; desc: boolean }[];

/** Multi-select filters the FilterBar shows, in chip order. Values are comma lists in the URL. */
export const MULTI_FILTERS = [
  'status',
  'criticality',
  'departmentId',
  'actId',
  'unitId',
  'categoryId',
] as const;
export type MultiFilter = (typeof MULTI_FILTERS)[number];

/** The due-date range filter: one FilterBar key, two URL keys. */
export const DUE_FILTER = 'due';

/** URL keys that are register state and pass straight through to the API (validated first). */
const PASS_THROUGH = [
  ...MULTI_FILTERS,
  'ownerId',
  'approverId',
  'workflowState',
  'timelineType',
  'domain',
  'dueFrom',
  'dueTo',
  'completedFrom',
  'completedTo',
  'hasEvidence',
] as const satisfies readonly (keyof typeof registerFilterShape)[];

export const SEARCH_PARAM = 'search';
export const SORT_PARAM = 'sort';
export const VIEW_PARAM = 'view';
export const DEFAULT_SORT = 'dueDate';

/** The Source filter's FilterBar key, the same as its URL and API key (./source.ts). */
export const SOURCE_FILTER = SOURCE_PARAM;

/** Keys a saved view holds: everything that shapes the rows, but not the period or the view id itself. */
const VIEW_KEYS = [...PASS_THROUGH, SOURCE_PARAM, SEARCH_PARAM, SORT_PARAM] as const;

type FilterKey = (typeof PASS_THROUGH)[number];

/** One URL value, or undefined when the contract would reject it. A bad link degrades to "no filter", not an error. */
function validValue(key: FilterKey, value: string | null): string | undefined {
  if (value === null || value === '') return undefined;
  return registerFilterShape[key].safeParse(value).success ? value : undefined;
}

function validSearch(value: string | null): string | undefined {
  return value !== null && registerFilterShape.q.safeParse(value).success
    ? value.trim()
    : undefined;
}

const SORT_FIELDS = new Set<string>(REGISTER_SORT_FIELDS);

/** `?sort=` keys in order, keeping only fields the API can sort by. */
export function sortingFromParams(params: Params): SortingState {
  const raw = params.get(SORT_PARAM) ?? DEFAULT_SORT;
  const keys = raw
    .split(',')
    .map((part) => ({ id: part.replace(/^-/, ''), desc: part.startsWith('-') }))
    .filter((k) => SORT_FIELDS.has(k.id));
  return keys.length > 0 ? keys : [{ id: DEFAULT_SORT, desc: false }];
}

/**
 * The period the register shows: the URL's, or the client's current one, which is what the period picker displays
 * when the URL has none (lib/shell/ShellFrame.tsx). As API values via lib/period.ts.
 */
export function registerPeriod(
  params: Params,
  client: { fyStartMonth: number; thisPeriod: Period },
): PeriodApiQuery {
  return periodApiQuery(periodFromParams(params) ?? client.thisPeriod, client.fyStartMonth);
}

/**
 * The API query for the register: validated filters, search, sort and the selected period. An explicit due-date
 * filter wins over the period, because the contract takes one or the other (checkPeriod) and the person chose it.
 * `iso` is whether the account has the ISO add-on: only then does the URL's `source` reach the API.
 */
export function apiQueryFromParams(
  params: Params,
  period?: PeriodApiQuery,
  iso = false,
): URLSearchParams {
  const query = new URLSearchParams();
  for (const key of PASS_THROUGH) {
    const value = validValue(key, params.get(key));
    if (value !== undefined) query.set(key, value);
  }
  const source = sourceFromParams(params, iso);
  if (source) query.set(SOURCE_PARAM, source);
  if (period && !query.has('dueFrom') && !query.has('dueTo')) {
    if ('fy' in period) {
      if (registerFilterShape.fy.safeParse(period.fy).success) query.set('fy', period.fy);
    } else {
      query.set('dueFrom', period.from);
      query.set('dueTo', period.to);
    }
  }
  // Ranges must run forwards; drop the end of a reversed one rather than the whole filter.
  if (query.has('dueFrom') && query.has('dueTo') && query.get('dueTo')! < query.get('dueFrom')!) {
    query.delete('dueTo');
  }
  if (
    query.has('completedFrom') &&
    query.has('completedTo') &&
    query.get('completedTo')! < query.get('completedFrom')!
  ) {
    query.delete('completedTo');
  }
  const search = validSearch(params.get(SEARCH_PARAM));
  if (search) query.set('q', search);
  query.set(
    SORT_PARAM,
    sortingFromParams(params)
      .map((s) => `${s.desc ? '-' : ''}${s.id}`)
      .join(','),
  );
  // Belt and braces: everything above is built to pass, and the test suite holds it to that.
  if (!RegisterQuery.safeParse(Object.fromEntries(query)).success) {
    throw new Error('Register query failed its contract schema');
  }
  return query;
}

/** FilterBar value from the URL; the Source filter only with the ISO add-on (`iso`). */
export function filterValueFromParams(params: Params, iso = false): Record<string, FilterValue> {
  const value: Record<string, FilterValue> = {};
  for (const key of MULTI_FILTERS) {
    const raw = validValue(key, params.get(key));
    if (raw) value[key] = raw.split(',');
  }
  const source = sourceFromParams(params, iso);
  if (source) value[SOURCE_FILTER] = [source];
  const from = validValue('dueFrom', params.get('dueFrom'));
  const to = validValue('dueTo', params.get('dueTo'));
  if (from || to) value[DUE_FILTER] = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  return value;
}

const isRange = (v: FilterValue | undefined): v is DateRange => !!v && !Array.isArray(v);

/** Writes a FilterBar value into a copy of the URL, keeping the period, sort, search and other parameters. */
export function withFilters(
  search: string | URLSearchParams,
  value: Record<string, FilterValue>,
): URLSearchParams {
  const source = value[SOURCE_FILTER];
  const next = withSource(search, sourceOfTicks(Array.isArray(source) ? source : undefined));
  for (const key of MULTI_FILTERS) {
    const v = value[key];
    if (Array.isArray(v) && v.length > 0) next.set(key, v.join(','));
    else next.delete(key);
  }
  const due = value[DUE_FILTER];
  for (const [urlKey, part] of [
    ['dueFrom', 'from'],
    ['dueTo', 'to'],
  ] as const) {
    const date = isRange(due) ? due[part] : undefined;
    if (date) next.set(urlKey, date);
    else next.delete(urlKey);
  }
  return next;
}

export function withSearch(search: string | URLSearchParams, text: string): URLSearchParams {
  const next = new URLSearchParams(search);
  const trimmed = text.trim();
  if (trimmed) next.set(SEARCH_PARAM, trimmed);
  else next.delete(SEARCH_PARAM);
  return next;
}

/** Writes the sort; the default (due date, ascending) is left out so plain links stay short. */
export function withSorting(
  search: string | URLSearchParams,
  sorting: SortingState,
): URLSearchParams {
  const next = new URLSearchParams(search);
  const value = sorting
    .filter((s) => SORT_FIELDS.has(s.id))
    .map((s) => `${s.desc ? '-' : ''}${s.id}`)
    .join(',');
  if (value && value !== DEFAULT_SORT) next.set(SORT_PARAM, value);
  else next.delete(SORT_PARAM);
  return next;
}

/** The part of the URL a saved view stores, in a stable order so two views can be compared as strings. */
export function viewQuery(params: Params): string {
  const out = new URLSearchParams();
  for (const key of VIEW_KEYS) {
    const value = params.get(key);
    if (value) out.set(key, value);
  }
  if (out.get(SORT_PARAM) === DEFAULT_SORT) out.delete(SORT_PARAM);
  return out.toString();
}

/** Replaces the view part of the URL with a stored view, keeping the period. `viewId` undefined = Default. */
export function withView(
  search: string | URLSearchParams,
  stored: string,
  viewId: string | undefined,
): URLSearchParams {
  const next = new URLSearchParams(search);
  for (const key of VIEW_KEYS) next.delete(key);
  for (const [key, value] of new URLSearchParams(stored)) {
    if ((VIEW_KEYS as readonly string[]).includes(key)) next.set(key, value);
  }
  if (viewId) next.set(VIEW_PARAM, viewId);
  else next.delete(VIEW_PARAM);
  return next;
}

/** Filter options for the two enum filters, in enum order (FilterBar `order: 'given'`). */
export const STATUS_OPTIONS = DerivedStatus.options;
export const CRITICALITY_OPTIONS = Criticality.options;
