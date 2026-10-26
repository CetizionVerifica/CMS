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
  objectiveFilterDefs,
  objectiveFilters,
  objectiveFilterValue,
  objectivesQuery,
  objectiveSystems,
} from './objectives-model';
import { ObjectivesView } from './ObjectivesView';

type Props = {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const TITLE = 'Objectives';

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return isoMetadata((await params).clientId, TITLE);
}

// Objectives and their plans (packages.md ISO-6b): what each system aims at, and how its readings stand.
export default async function IsoObjectivesPage({ params, searchParams }: Props) {
  const { clientId } = await params;
  const gate = await isoGate(clientId);
  if (!gate.on) return null;
  const search = await searchParams;
  const api = await serverApi();
  const create = mayCall('createIsoObjective', gate.roles, true);
  const loaded = await isoLoad(async () => {
    const systemList = await systems(api, clientId);
    const filters = objectiveFilters(
      search,
      systemList.map((s) => s.id),
    );
    const [objectives, standardList, peopleList, risks] = await Promise.all([
      allPages(
        async (query) =>
          (
            await api.call('listIsoObjectives', {
              params: { clientId },
              query: { ...objectivesQuery(filters), ...query },
            })
          ).data,
      ),
      standards(api, clientId),
      people(api, clientId),
      // The risk items a new objective can address; only read when the person may add one.
      create
        ? allPages(
            async (query) => (await api.call('listIsoRisks', { params: { clientId }, query })).data,
          )
        : Promise.resolve([]),
    ]);
    return { systemList, filters, objectives, standardList, peopleList, risks };
  });
  if (!loaded.ok) {
    return <IsoRefusal refusal={loaded.refusal} title={TITLE} homeHref={gate.homeHref} />;
  }
  const { systemList, filters, objectives, standardList, peopleList, risks } = loaded.data;
  const header = (
    <PageHeader
      title={TITLE}
      description="What each management system aims at, how its readings stand, and the plan to get there."
    />
  );
  if (systemList.length === 0) {
    return (
      <>
        {header}
        <PageEmpty
          title="No management system yet"
          body="Objectives belong to a management system. Set one up on the ISO overview first."
          action={{ label: 'Go to ISO overview', href: isoPath(clientId, 'overview') }}
        />
      </>
    );
  }
  const path = isoPath(clientId, 'objectives');

  return (
    <>
      {header}
      <ObjectivesView
        clientId={clientId}
        objectives={objectives}
        standards={standardList}
        people={peopleList}
        filters={objectiveFilterDefs(standardList)}
        filterValue={objectiveFilterValue(filters)}
        fromOverview={filters.ids.length > 0}
        clearHref={path}
        create={
          create
            ? {
                systems: objectiveSystems(systemList, standardList, risks),
                people: peopleList,
                ownerOnly: mayCall('createIsoObjective', gate.roles) ? null : gate.personId,
                today: clientToday(gate.client.timeZone),
              }
            : null
        }
      />
    </>
  );
}
