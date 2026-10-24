import type { Company, Location, Unit } from '@canopy/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { isApiError } from '../../../../../../lib/api/client';
import { redirectIfSignedOut } from '../../overview/signed-out';
import { serverApi } from '../../../../../../lib/api/server';
import { NoPermission, PageHeader } from '../../../../../../lib/patterns';
import { routeByPath, visibleTo } from '../../../../../../lib/routes';
import { homeHref } from '../../../../../../lib/shell/model';
import { loadShell } from '../../../../../../lib/shell/server';
import { EntitiesView } from './EntitiesView';
import { companyRows, locationOptions, unitRows } from './entities-model';

type Props = { params: Promise<{ clientId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { clientId } = await params;
  const client = (await loadShell()).clients.find((c) => c.id === clientId);
  return { title: ['Entities', client?.name].filter(Boolean).join(' · ') };
}

/** Every page of a list, up to `maxPages` pages of 200; setup lists are tens of rows, not thousands. */
async function all<T>(
  fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor: string | null }>,
  maxPages = 10,
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage(cursor);
    rows.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return rows;
}

// Setup: the client's companies and units (MODULES.md M13 "setup screens").
export default async function EntitiesPage({ params }: Props) {
  const { clientId } = await params;
  const model = await loadShell();
  const client = model.clients.find((c) => c.id === clientId);
  if (!client) notFound();
  // Owners and approvers can read some of this through the API but change none of it, so the page is not theirs.
  if (!visibleTo(routeByPath('setup/entities'), model.roles.byClient[clientId] ?? [])) {
    return (
      <NoPermission
        what="entities"
        backHref={`/c/${clientId}/overview`}
        backLabel="Go to overview"
      />
    );
  }
  const api = await serverApi();
  const query = (cursor: string | undefined) => ({ limit: '200', ...(cursor ? { cursor } : {}) });

  let companies: Company[], units: Unit[], locations: Location[];
  try {
    [companies, units, locations] = await Promise.all([
      all<Company>(
        async (c) =>
          (await api.call('listCompanies', { params: { clientId }, query: query(c) })).data,
      ),
      all<Unit>(
        async (c) => (await api.call('listUnits', { params: { clientId }, query: query(c) })).data,
      ),
      all<Location>(async (c) => (await api.call('listLocations', { query: query(c) })).data),
    ]);
  } catch (error) {
    await redirectIfSignedOut(error);
    if (isApiError(error, 'FORBIDDEN', 'ACCESS_EXPIRED')) {
      return <NoPermission what="entities" backHref={homeHref(model)} backLabel="Go to home" />;
    }
    throw error;
  }

  return (
    <>
      <PageHeader
        title="Entities"
        description={`${client.name}'s companies and the units (plants, sites, offices) under them.`}
      />
      <EntitiesView
        clientId={clientId}
        companies={companyRows(companies, units)}
        units={unitRows(units, companies, locations)}
        locations={locationOptions(locations)}
      />
    </>
  );
}
