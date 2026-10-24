import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { isApiError } from '../../../lib/api/client';
import { redirectIfSignedOut } from '../c/[clientId]/overview/signed-out';
import { serverApi } from '../../../lib/api/server';
import { NoPermission, PageEmpty, PageHeader } from '../../../lib/patterns';
import { routeByPath, visibleTo } from '../../../lib/routes';
import { homeHref } from '../../../lib/shell/model';
import { loadShell } from '../../../lib/shell/server';
import { PortfolioTable } from './PortfolioTable';
import { portfolioItems, portfolioSummary } from './portfolio-model';

export const metadata: Metadata = { title: 'Portfolio' };

// Consultant home (PLAN.md §5, screen 1): every client the signed-in firm user sees, with score, overdue, due this week and
// last activity. Numbers come from GET /portfolio for the current period.
export default async function PortfolioPage() {
  const model = await loadShell();
  // A company account with one client has no portfolio (ADR M15-0001 decision 2): a typed URL goes to its client.
  if (model.showPortfolio === false) redirect(homeHref(model));
  const noAccess = (
    <NoPermission what="the portfolio" backHref={homeHref(model)} backLabel="Go to home" />
  );
  if (!visibleTo(routeByPath('portfolio'), model.roles.firm)) return noAccess;

  let rows;
  try {
    rows = (await (await serverApi()).portfolio()).data.items;
  } catch (error) {
    await redirectIfSignedOut(error);
    if (isApiError(error, 'FORBIDDEN', 'ACCESS_EXPIRED')) return noAccess;
    throw error;
  }

  const items = portfolioItems(
    rows,
    Object.fromEntries(model.clients.map((c) => [c.id, c.timeZone])),
  );
  if (items.length === 0) {
    return (
      <>
        <PageHeader title="Portfolio" />
        <PageEmpty
          title="No clients yet"
          body="Clients you are assigned to appear here with their score and overdue items."
        />
      </>
    );
  }
  return (
    <>
      <PageHeader title="Portfolio" description={portfolioSummary(items)} />
      <PortfolioTable items={items} />
    </>
  );
}
