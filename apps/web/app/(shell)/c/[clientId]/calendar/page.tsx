import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { isApiError } from '../../../../../lib/api/client';
import { serverApi } from '../../../../../lib/api/server';
import { NoPermission, PageHeader } from '../../../../../lib/patterns';
import { periodFromParams } from '../../../../../lib/period';
import { homeHref } from '../../../../../lib/shell/model';
import { loadShell } from '../../../../../lib/shell/server';
import { isoOn, sourceFromParams } from '../register/_lib/source';
import { CalendarView } from './_components/CalendarView';
import { loadMonth } from './_lib/calendar-api';
import { monthToShow, todayIn } from './_lib/month';

type Props = {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** "Calendar · Demo Metals", as every client page is titled (the shell adds the product name). */
export async function generateMetadata({ params }: Pick<Props, 'params'>): Promise<Metadata> {
  const { clientId } = await params;
  const client = (await loadShell()).clients.find((c) => c.id === clientId);
  return { title: ['Calendar', client?.name].filter(Boolean).join(' · ') };
}

/** Next's search params as URLSearchParams; a repeated key keeps its first value. */
function toSearch(raw: Record<string, string | string[] | undefined>): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) search.set(key, first);
  }
  return search;
}

// The compliance calendar (PLAN.md "Calendar"): one month of due dates, as a grid or a list, coloured by status. The
// month follows the URL's period (`?fy=&m=`); without one it opens on this month when the period includes it.
export default async function CalendarPage({ params, searchParams }: Props) {
  const { clientId } = await params;
  const search = toSearch(await searchParams);
  const model = await loadShell();
  const client = model.clients.find((c) => c.id === clientId);
  // The client layout already checked the session and 404s an unknown client; this keeps the types honest.
  if (!client) notFound();

  const today = todayIn(client.timeZone);
  const period = periodFromParams(search) ?? client.thisPeriod;
  const month = monthToShow(period, client.fyStartMonth, today);
  // With the ISO add-on the calendar takes the Source filter from the URL; without it a stale `source` is ignored.
  const iso = isoOn(model.features);
  const source = sourceFromParams(search, iso);
  let due;
  try {
    due = await loadMonth(await serverApi(), clientId, month, source);
  } catch (error) {
    if (isApiError(error, 'FORBIDDEN', 'ACCESS_EXPIRED')) {
      return (
        <NoPermission what="this calendar" backHref={homeHref(model)} backLabel="Go to home" />
      );
    }
    // The API answers 404 for a client outside the person's scope (api-conventions.md §5).
    if (isApiError(error, 'NOT_FOUND')) notFound();
    throw error;
  }

  return (
    <>
      <PageHeader title="Calendar" description={`Due dates for ${client.name}, by month.`} />
      <CalendarView
        clientId={clientId}
        month={month}
        today={today}
        due={due}
        fyStartMonth={client.fyStartMonth}
        view={search.get('view') === 'list' ? 'list' : 'month'}
        query={search.toString()}
        iso={iso}
        source={source}
      />
    </>
  );
}
