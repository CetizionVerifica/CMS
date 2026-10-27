import type { Metadata } from 'next';

import { serverApi } from '../../../../../../lib/api/server';
import { PageEmpty, PageHeader } from '../../../../../../lib/patterns';
import { allPages, clauses, people, standards, systems, units } from '../_lib/data';
import { isoGate, isoLoad, isoMetadata } from '../_lib/gate';
import { mayCall } from '../_lib/may';
import { clientToday } from '../_lib/people';
import { IsoRefusal } from '../_components/IsoStates';
import { isoPath } from '../overview/overview-model';
import {
  ncExportQuery,
  ncFilterDefs,
  ncFilters,
  ncFilterValue,
  ncRows,
  ncsQuery,
  ncSystems,
} from './nc-model';
import { NcLogView } from './NcLogView';

type Props = {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const TITLE = 'Nonconformities';

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return isoMetadata((await params).clientId, TITLE);
}

// The nonconformity log (packages.md ISO-6c): nonconformities, incidents and near misses of the client's systems.
export default async function IsoNonconformitiesPage({ params, searchParams }: Props) {
  const { clientId } = await params;
  const gate = await isoGate(clientId);
  if (!gate.on) return null;
  const search = await searchParams;
  const api = await serverApi();
  const mayRaise = mayCall('raiseIsoNonconformity', gate.roles);
  const loaded = await isoLoad(async () => {
    const systemList = await systems(api, clientId);
    const filters = ncFilters(
      search,
      systemList.map((s) => s.id),
    );
    const [ncs, unitList, peopleList, standardList, clauseList, risks] = await Promise.all([
      allPages(
        async (query) =>
          (
            await api.call('listIsoNonconformities', {
              params: { clientId },
              query: { ...ncsQuery(filters), ...query },
            })
          ).data,
      ),
      units(api, clientId),
      people(api, clientId),
      // What the raise form offers, read only for someone who may raise.
      mayRaise ? standards(api, clientId) : [],
      mayRaise ? clauses(api, clientId) : [],
      mayRaise
        ? allPages(
            async (query) => (await api.call('listIsoRisks', { params: { clientId }, query })).data,
          )
        : [],
    ]);
    return { systemList, filters, ncs, unitList, peopleList, standardList, clauseList, risks };
  });
  if (!loaded.ok) {
    return <IsoRefusal refusal={loaded.refusal} title={TITLE} homeHref={gate.homeHref} />;
  }
  const { systemList, filters, ncs, unitList, peopleList, standardList, clauseList, risks } =
    loaded.data;
  const header = (
    <PageHeader
      title={TITLE}
      description="The nonconformity log: nonconformities, incidents and near misses, their investigation, corrective action and the check that it worked."
    />
  );
  if (systemList.length === 0) {
    return (
      <>
        {header}
        <PageEmpty
          title="No management system yet"
          body="Nonconformities belong to a management system. Set one up on the ISO overview first."
          action={{ label: 'Go to ISO overview', href: isoPath(clientId, 'overview') }}
        />
      </>
    );
  }
  const path = isoPath(clientId, 'nonconformities');

  return (
    <>
      {header}
      <NcLogView
        clientId={clientId}
        rows={ncRows(ncs, unitList, peopleList)}
        filters={ncFilterDefs()}
        filterValue={ncFilterValue(filters)}
        fromOverview={filters.ids.length > 0}
        clearHref={path}
        exportFilters={new URLSearchParams(ncExportQuery(filters)).toString()}
        raise={
          mayRaise
            ? {
                clientId,
                systems: ncSystems(systemList, standardList, clauseList, risks),
                units: unitList
                  .filter((u) => u.archivedAt === null)
                  .map((u) => ({ id: u.id, name: u.name })),
                people: peopleList,
                today: clientToday(gate.client.timeZone),
                timeZone: gate.client.timeZone,
              }
            : null
        }
      />
    </>
  );
}
