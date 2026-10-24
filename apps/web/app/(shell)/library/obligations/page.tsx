import { Criticality, Jurisdiction, ObligationDomain, RuleStatus } from '@canopy/contracts';
import type { FilterDef } from '@canopy/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';

import { isApiError } from '../../../../lib/api/client';
import { serverApi } from '../../../../lib/api/server';
import { NoPermission, PageEmpty, PageHeader } from '../../../../lib/patterns';
import { homeHref } from '../../../../lib/shell/model';
import { loadShell } from '../../../../lib/shell/server';
import { LibraryFilterBar } from '../LibraryFilterBar';
import { LibraryNav } from '../LibraryNav';
import { ObligationsTable } from '../ObligationsTable';
import { loadAllActs, toSearchParams } from '../library-data';
import {
  countText,
  cursorParam,
  isFiltered,
  libraryCopy,
  nextPageHref,
  obligationFilters,
  obligationItems,
  obligationQuery,
  searchHint,
  searchText,
} from '../library-model';

export const metadata: Metadata = { title: 'Obligations' };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const JURISDICTION_LABEL: Record<Jurisdiction, string> = { CENTRAL: 'Central', STATE: 'State' };
const RULE_LABEL: Record<RuleStatus, string> = { CONFIRMED: 'Confirmed', TO_REVIEW: 'To review' };

// The firm library's obligations, filterable by Act, domain, criticality, jurisdiction and recurrence status.
export default async function ObligationsPage({ searchParams }: Props) {
  const params = toSearchParams(await searchParams);
  const q = searchText(params);
  const cursor = cursorParam(params);
  const filters = obligationFilters(params);

  const api = await serverApi();
  let page;
  let acts;
  try {
    [page, acts] = await Promise.all([
      api
        .call('listObligations', { query: obligationQuery(filters, q, cursor) })
        .then((r) => r.data),
      loadAllActs(api),
    ]);
  } catch (error) {
    if (isApiError(error, 'FORBIDDEN', 'ACCESS_EXPIRED')) {
      const model = await loadShell();
      return <NoPermission what="the library" backHref={homeHref(model)} backLabel="Go to home" />;
    }
    throw error;
  }

  const actNames = new Map(acts.map((a) => [a.id, a.name]));
  const items = obligationItems(page.items, actNames);
  const count = countText(items.length, page.total, 'obligation', 'obligations');
  const next = nextPageHref('/library/obligations', params, page.nextCursor);
  const filtered = isFiltered(q, filters);
  const hint = searchHint(params);
  const copy = libraryCopy((await loadShell()).isFirmUser);

  const defs: FilterDef[] = [
    {
      key: 'actId',
      label: 'Act',
      kind: 'multi',
      order: 'alpha',
      options: acts.map((a) => ({ value: a.id, label: a.name })),
    },
    {
      key: 'domain',
      label: 'Domain',
      kind: 'multi',
      options: ObligationDomain.options.map((d) => ({ value: d, label: d })),
    },
    {
      key: 'criticality',
      label: 'Criticality',
      kind: 'multi',
      display: 'criticality',
      options: Criticality.options.map((c) => ({ value: c, label: c })),
    },
    {
      key: 'jurisdiction',
      label: 'Jurisdiction',
      kind: 'multi',
      options: Jurisdiction.options.map((j) => ({ value: j, label: JURISDICTION_LABEL[j] })),
    },
    {
      key: 'ruleStatus',
      label: 'Recurrence',
      kind: 'multi',
      options: RuleStatus.options.map((r) => ({ value: r, label: RULE_LABEL[r] })),
    },
  ];

  return (
    <>
      <PageHeader title="Obligations" description={copy.obligations.description} />
      <LibraryNav current="obligations" />
      <LibraryFilterBar
        filters={defs}
        value={filters}
        placeholder="Search obligations"
        resultText={hint ?? count}
        resultCount={items.length}
      />
      {items.length === 0 && !filtered && !cursor ? (
        <PageEmpty title="No obligations yet" body={copy.obligations.emptyBody} />
      ) : (
        <>
          <p className="mb-2 text-meta text-muted">{hint ?? count}</p>
          <ObligationsTable
            items={items}
            empty={<p className="p-4 text-body text-muted">No obligations match these filters.</p>}
          />
          {next ? (
            <NextLink href={next} className="mt-3 inline-block text-body text-forest underline">
              Next page
            </NextLink>
          ) : null}
        </>
      )}
    </>
  );
}
