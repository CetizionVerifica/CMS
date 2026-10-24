import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { isApiError } from '../../../../../lib/api/client';
import { serverApi } from '../../../../../lib/api/server';
import { NoPermission, PageHeader } from '../../../../../lib/patterns';
import { periodApiQuery, periodFromParams } from '../../../../../lib/period';
import { routeByPath, visibleTo } from '../../../../../lib/routes';
import { homeHref } from '../../../../../lib/shell/model';
import { loadShell } from '../../../../../lib/shell/server';
import { redirectIfSignedOut } from '../overview/signed-out';
import { ReportsView } from './ReportsView';
import { overdueRows, reportRows } from './reports-model';

type Props = {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { clientId } = await params;
  const client = (await loadShell()).clients.find((c) => c.id === clientId);
  return { title: ['Reports', client?.name].filter(Boolean).join(' · ') };
}

function toSearchParams(raw: Record<string, string | string[] | undefined>): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') search.set(key, value);
    else if (Array.isArray(value) && value[0] !== undefined) search.set(key, value[0]);
  }
  return search;
}

// Reports (MODULES.md M13 "reports and audit pages"): scores by Act and by department, the overdue list and the
// Excel and PDF downloads, for the period the shell's picker shows. The numbers are M10's (engine output).
export default async function ReportsPage({ params, searchParams }: Props) {
  const { clientId } = await params;
  const model = await loadShell();
  const client = model.clients.find((c) => c.id === clientId);
  if (!client) notFound();
  // Owners see their own items on the overview and the list; the reports are for the client as a whole.
  if (!visibleTo(routeByPath('reports'), model.roles.byClient[clientId] ?? [])) {
    return (
      <NoPermission
        what="reports"
        backHref={`/c/${clientId}/overview`}
        backLabel="Go to overview"
      />
    );
  }
  const period = periodFromParams(toSearchParams(await searchParams)) ?? client.thisPeriod;
  const query = periodApiQuery(period, client.fyStartMonth);
  const request = { params: { clientId }, query };

  const api = await serverApi();
  let data;
  try {
    const [acts, departments, overdue] = await Promise.all([
      api.call('actReport', request),
      api.call('departmentReport', request),
      api.call('overdueReport', request),
    ]);
    data = {
      acts: reportRows(clientId, acts.data, 'actId', period),
      departments: reportRows(clientId, departments.data, 'departmentId', period),
      overdue: overdueRows(overdue.data.items, period),
    };
  } catch (error) {
    await redirectIfSignedOut(error);
    if (isApiError(error, 'NOT_FOUND')) notFound();
    if (isApiError(error, 'FORBIDDEN', 'ACCESS_EXPIRED')) {
      return <NoPermission what="reports" backHref={homeHref(model)} backLabel="Go to home" />;
    }
    throw error;
  }

  return (
    <>
      <PageHeader
        title="Reports"
        description="Scores and counts for the selected period. Every number opens the instances behind it."
      />
      <ReportsView clientId={clientId} fy={period?.fy ?? null} {...data} />
    </>
  );
}
