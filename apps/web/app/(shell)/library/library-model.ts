// The firm library screens (Acts and Obligations): URL state for search, filters and paging, and the rows the tables
// show. Display only: rule status, criticality and the rest come from the API (apps/web/CLAUDE.md).
import {
  Criticality,
  Jurisdiction,
  ObligationDomain,
  RuleStatus,
  type Act,
  type Obligation,
} from '@canopy/contracts';

type Params = { get(name: string): string | null };

/** Library search needs at least 2 characters (contracts `SearchText`); shorter text is ignored. */
export function searchText(params: Params): string | undefined {
  const q = params.get('q')?.trim();
  return q && q.length >= 2 ? q.slice(0, 200) : undefined;
}

/** What to say when the search box holds text too short to search with, so it isn't silently ignored. */
export function searchHint(params: Params): string | undefined {
  const q = params.get('q')?.trim();
  return q && q.length < 2 ? 'Type at least 2 characters to search.' : undefined;
}

export function cursorParam(params: Params): string | undefined {
  return params.get('cursor') || undefined;
}

/** "Central" or "State · WB". */
export function jurisdictionLabel(jurisdiction: Jurisdiction, stateCode: string | null): string {
  return jurisdiction === 'STATE' ? `State · ${stateCode ?? '—'}` : 'Central';
}

export type ActItem = {
  id: string;
  name: string;
  shortName: string | null;
  jurisdiction: string;
  aliases: string;
  obligationsHref: string;
};

export function actItems(acts: readonly Act[]): ActItem[] {
  return acts.map((act) => ({
    id: act.id,
    name: act.name,
    shortName: act.shortName,
    jurisdiction: jurisdictionLabel(act.jurisdiction, act.stateCode),
    aliases: act.aliases.join(', '),
    obligationsHref: `/library/obligations?${new URLSearchParams({ actId: act.id }).toString()}`,
  }));
}

/** Obligation filters that live in the URL, named as the API names them (ObligationListQuery). */
export const OBLIGATION_FILTERS = [
  'actId',
  'domain',
  'criticality',
  'jurisdiction',
  'ruleStatus',
] as const;
export type ObligationFilterKey = (typeof OBLIGATION_FILTERS)[number];
export type ObligationFilters = Partial<Record<ObligationFilterKey, string[]>>;

const allowed: Record<ObligationFilterKey, (v: string) => boolean> = {
  actId: (v) => /^[0-9a-f-]{36}$/i.test(v),
  domain: (v) => ObligationDomain.safeParse(v).success,
  criticality: (v) => Criticality.safeParse(v).success,
  jurisdiction: (v) => Jurisdiction.safeParse(v).success,
  ruleStatus: (v) => RuleStatus.safeParse(v).success,
};

/** Reads the filters from the URL, dropping values the API would reject, so a bad link shows results, not an error. */
export function obligationFilters(params: Params): ObligationFilters {
  const out: ObligationFilters = {};
  for (const key of OBLIGATION_FILTERS) {
    const values = (params.get(key) ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v && allowed[key](v));
    if (values.length > 0) out[key] = [...new Set(values)];
  }
  return out;
}

/**
 * The one value the API takes for jurisdiction or rule status. Each has two values, so both ticked means no filter;
 * the bar keeps showing both ticks.
 */
const single = <T extends string>(values: string[] | undefined): T | undefined =>
  values?.length === 1 ? (values[0] as T) : undefined;

/** The API query for the obligation list: comma lists as the contract expects. */
export function obligationQuery(filters: ObligationFilters, q?: string, cursor?: string) {
  const jurisdiction = single<Jurisdiction>(filters.jurisdiction);
  const ruleStatus = single<RuleStatus>(filters.ruleStatus);
  return {
    limit: '50',
    count: 'true' as const,
    ...(q ? { q } : {}),
    ...(cursor ? { cursor } : {}),
    ...(filters.actId ? { actId: filters.actId.join(',') } : {}),
    ...(filters.domain ? { domain: filters.domain.join(',') } : {}),
    ...(filters.criticality ? { criticality: filters.criticality.join(',') } : {}),
    ...(jurisdiction ? { jurisdiction } : {}),
    ...(ruleStatus ? { ruleStatus } : {}),
  };
}

/** The same page with `changes` applied; `undefined` or an empty list removes a parameter. Paging always restarts. */
export function withParams(
  path: string,
  current: URLSearchParams,
  changes: Record<string, string | string[] | undefined>,
): string {
  const next = new URLSearchParams(current);
  next.delete('cursor');
  for (const [key, value] of Object.entries(changes)) {
    const text = Array.isArray(value) ? value.join(',') : value;
    if (text) next.set(key, text);
    else next.delete(key);
  }
  const query = next.toString();
  return query ? `${path}?${query}` : path;
}

/** The link to the next page of results, or undefined on the last page. */
export function nextPageHref(
  path: string,
  current: URLSearchParams,
  nextCursor: string | null,
): string | undefined {
  if (!nextCursor) return undefined;
  const next = new URLSearchParams(current);
  next.set('cursor', nextCursor);
  return `${path}?${next.toString()}`;
}

export type ObligationItem = {
  id: string;
  ref: string | null;
  title: string;
  actName: string;
  domain: string;
  jurisdiction: string;
  criticality: Criticality;
  /** True when the recurrence was inferred on import and a consultant has not confirmed it yet. */
  toReview: boolean;
};

export function obligationItems(
  obligations: readonly Obligation[],
  actNames: ReadonlyMap<string, string>,
): ObligationItem[] {
  return obligations.map((o) => ({
    id: o.id,
    ref: o.externalRef,
    title: o.title,
    actName: actNames.get(o.actId) ?? 'Unknown Act',
    domain: o.domain,
    jurisdiction: jurisdictionLabel(o.jurisdiction, o.stateCode),
    criticality: o.criticality,
    toReview: o.ruleStatus === 'TO_REVIEW',
  }));
}

/** Whether the list is narrowed: a search the API applies, or any filter in the URL. */
export function isFiltered(q: string | undefined, filters: ObligationFilters = {}): boolean {
  return Boolean(q) || Object.keys(filters).length > 0;
}

/** "Showing 50 of 119 obligations". */
export function countText(shown: number, total: number | undefined, one: string, other: string) {
  const noun = (n: number) => (n === 1 ? one : other);
  if (total === undefined || total === shown) return `${shown} ${noun(shown)}`;
  return `Showing ${shown} of ${total} ${noun(total)}`;
}

export type LibraryCopy = Record<
  'acts' | 'obligations',
  { description: string; emptyBody: string }
>;

/**
 * Page wording by who is reading. Firm users see the whole firm library; client users see only what is assigned in
 * their client (the API scopes the lists), so they are not told about a library shared by every client.
 */
export function libraryCopy(isFirmUser: boolean): LibraryCopy {
  if (isFirmUser) {
    return {
      acts: {
        description: 'The Acts in the firm library, shared by every client.',
        emptyBody: "Acts are added when a client's register is imported, or by a consultant.",
      },
      obligations: {
        description: 'The obligations under each Act in the firm library, shared by every client.',
        emptyBody:
          "Obligations are added when a client's register is imported, or by a consultant.",
      },
    };
  }
  return {
    acts: {
      description: 'The Acts that apply to your organisation.',
      emptyBody: 'Your consultant adds the Acts that apply to you.',
    },
    obligations: {
      description: 'The obligations under the Acts that apply to your organisation.',
      emptyBody: 'Your consultant adds the obligations that apply to you.',
    },
  };
}
