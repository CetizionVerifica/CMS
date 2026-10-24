import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { isApiError } from '../../../../../lib/api/client';
import { redirectIfSignedOut } from './signed-out';
import { serverApi } from '../../../../../lib/api/server';
import { NoPermission, PageHeader } from '../../../../../lib/patterns';
import { periodApiQuery, periodFromParams } from '../../../../../lib/period';
import { homeHref } from '../../../../../lib/shell/model';
import { loadShell } from '../../../../../lib/shell/server';
import { OverviewView } from './OverviewView';
import { overviewModel } from './overview-model';

type Props = {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { clientId } = await params;
  const client = (await loadShell()).clients.find((c) => c.id === clientId);
  return { title: ['Overview', client?.name].filter(Boolean).join(' · ') };
}

function toSearchParams(raw: Record<string, string | string[] | undefined>): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') search.set(key, value);
    else if (Array.isArray(value) && value[0] !== undefined) search.set(key, value[0]);
  }
  return search;
}

// Client overview (PLAN.md §5, screen 2). The client layout has already checked the user can see this client.
// Numbers are the API's for the selected period.
export default async function OverviewPage({ params, searchParams }: Props) {
  const { clientId } = await params;
  const model = await loadShell();
  const client = model.clients.find((c) => c.id === clientId);
  if (!client) notFound();
  // The period the picker shows: the URL's, else the client's current one (as the shell does), sent to every call so
  // the numbers and the register links they open count the same rows.
  const period = periodFromParams(toSearchParams(await searchParams)) ?? client.thisPeriod;
  const query = periodApiQuery(period, client.fyStartMonth);

  const api = await serverApi();
  const request = { params: { clientId }, query };
  let data;
  try {
    const [overview, byDepartment, byAct, byCriticality] = await Promise.all([
      api.call('clientOverview', request),
      api.call('breakdown', { ...request, query: { ...query, by: 'department' } }),
      api.call('breakdown', { ...request, query: { ...query, by: 'act' } }),
      api.call('breakdown', { ...request, query: { ...query, by: 'criticality' } }),
    ]);
    data = overviewModel({
      clientId,
      period,
      overview: overview.data,
      byDepartment: byDepartment.data,
      byAct: byAct.data,
      byCriticality: byCriticality.data,
    });
  } catch (error) {
    await redirectIfSignedOut(error);
    if (isApiError(error, 'NOT_FOUND')) notFound();
    if (isApiError(error, 'FORBIDDEN', 'ACCESS_EXPIRED')) {
      return (
        <NoPermission what="this overview" backHref={homeHref(model)} backLabel="Go to home" />
      );
    }
    throw error;
  }

  return (
    <>
      <PageHeader title="Overview" description={data.greeting} />
      <OverviewView model={data} />
    </>
  );
}
