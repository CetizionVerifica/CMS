import type { Metadata } from 'next';
import NextLink from 'next/link';

import { isApiError } from '../../../../lib/api/client';
import { serverApi } from '../../../../lib/api/server';
import { NoPermission, PageEmpty, PageHeader } from '../../../../lib/patterns';
import { homeHref } from '../../../../lib/shell/model';
import { loadShell } from '../../../../lib/shell/server';
import { ActsTable } from '../ActsTable';
import { LibraryFilterBar } from '../LibraryFilterBar';
import { LibraryNav } from '../LibraryNav';
import { toSearchParams } from '../library-data';
import { actItems, countText, cursorParam, nextPageHref, searchText } from '../library-model';

export const metadata: Metadata = { title: 'Acts · Library' };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

// The firm library's Acts (MODULES.md M13 "library screens"). Client roles see only Acts assigned in their client;
// the API applies that.
export default async function ActsPage({ searchParams }: Props) {
  const params = toSearchParams(await searchParams);
  const q = searchText(params);
  const cursor = cursorParam(params);

  let page;
  try {
    page = (
      await (
        await serverApi()
      ).call('listActs', {
        query: { limit: '50', count: 'true', ...(q ? { q } : {}), ...(cursor ? { cursor } : {}) },
      })
    ).data;
  } catch (error) {
    if (isApiError(error, 'FORBIDDEN', 'ACCESS_EXPIRED')) {
      const model = await loadShell();
      return <NoPermission what="the library" backHref={homeHref(model)} backLabel="Go to home" />;
    }
    throw error;
  }

  const items = actItems(page.items);
  const count = countText(items.length, page.total, 'Act', 'Acts');
  const next = nextPageHref('/library/acts', params, page.nextCursor);
  const filtered = Boolean(q);

  return (
    <>
      <PageHeader
        title="Library"
        description="Acts and the obligations under them, shared by every client."
      />
      <LibraryNav current="acts" />
      <LibraryFilterBar
        filters={[]}
        value={{}}
        placeholder="Search Acts"
        resultText={`${count} match`}
        resultCount={items.length}
      />
      {items.length === 0 && !filtered && !cursor ? (
        <PageEmpty
          title="No Acts yet"
          body="Acts are added when a client's register is imported, or by a consultant."
        />
      ) : (
        <>
          <p className="mb-2 text-meta text-muted" aria-live="polite">
            {count}
          </p>
          <ActsTable
            items={items}
            empty={<p className="p-4 text-body text-muted">No Acts match “{q}”.</p>}
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
