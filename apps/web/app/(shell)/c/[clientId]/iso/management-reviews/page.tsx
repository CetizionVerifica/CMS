import type { Metadata } from 'next';

import { serverApi } from '../../../../../../lib/api/server';
import { PageEmpty, PageHeader } from '../../../../../../lib/patterns';
import { allPages, people, standards, systems } from '../_lib/data';
import { isoGate, isoLoad, isoMetadata } from '../_lib/gate';
import { mayCall } from '../_lib/may';
import { clientToday } from '../_lib/people';
import { IsoRefusal } from '../_components/IsoStates';
import { isoPath } from '../overview/overview-model';
import {
  reviewFilterDefs,
  reviewFilters,
  reviewFilterValue,
  reviewRows,
  reviewsQuery,
  systemStandardOptions,
} from './review-model';
import { ReviewsView } from './ReviewsView';

type Props = {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const TITLE = 'Management reviews';

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return isoMetadata((await params).clientId, TITLE);
}

// The management reviews (packages.md ISO-6c, model §3.13): when the next one is due for each standard, and every
// review, filtered by the API.
export default async function IsoManagementReviewsPage({ params, searchParams }: Props) {
  const { clientId } = await params;
  const gate = await isoGate(clientId);
  if (!gate.on) return null;
  const search = await searchParams;
  const api = await serverApi();
  const loaded = await isoLoad(async () => {
    const [systemList, overview, peopleList, standardList] = await Promise.all([
      systems(api, clientId),
      api.call('getIsoOverview', { params: { clientId } }).then((r) => r.data),
      people(api, clientId),
      standards(api, clientId),
    ]);
    const filters = reviewFilters(
      search,
      systemList.map((s) => s.id),
    );
    const reviews = await allPages(
      async (page) =>
        (
          await api.call('listIsoManagementReviews', {
            params: { clientId },
            query: { ...reviewsQuery(filters), ...page },
          })
        ).data,
    );
    return { systemList, overview, peopleList, standardList, filters, reviews };
  });
  if (!loaded.ok) {
    return <IsoRefusal refusal={loaded.refusal} title={TITLE} homeHref={gate.homeHref} />;
  }
  const { systemList, overview, peopleList, standardList, filters, reviews } = loaded.data;
  const header = (
    <PageHeader
      title={TITLE}
      description="When the next review is due, and each review with its inputs, decisions and actions."
    />
  );
  if (systemList.length === 0) {
    return (
      <>
        {header}
        <PageEmpty
          title="No management system yet"
          body="Management reviews belong to a management system. Set one up on the ISO overview first."
          action={{ label: 'Go to ISO overview', href: isoPath(clientId, 'overview') }}
        />
      </>
    );
  }
  const many = systemList.length > 1;
  const shown = filters.managementSystemId
    ? overview.systems.filter((s) => s.managementSystemId === filters.managementSystemId)
    : overview.systems;

  return (
    <>
      {header}
      <ReviewsView
        clientId={clientId}
        due={shown.map((s) => ({
          systemId: s.managementSystemId,
          systemName: many ? s.name : null,
          due: s.managementReview,
        }))}
        standards={standardList}
        rows={reviewRows(reviews, systemList, standardList, peopleList)}
        filters={reviewFilterDefs()}
        filterValue={reviewFilterValue(filters)}
        plan={
          mayCall('planIsoManagementReview', gate.roles)
            ? {
                clientId,
                systems: systemList.map((s) => ({
                  id: s.id,
                  name: s.name,
                  standards: systemStandardOptions(s, standardList),
                })),
                people: peopleList,
                today: clientToday(gate.client.timeZone),
              }
            : null
        }
      />
    </>
  );
}
