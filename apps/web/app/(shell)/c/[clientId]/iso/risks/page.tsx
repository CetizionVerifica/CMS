import type { Metadata } from 'next';

import { serverApi } from '../../../../../../lib/api/server';
import { PageEmpty, PageHeader } from '../../../../../../lib/patterns';
import { allPages, people, systems, units } from '../_lib/data';
import { isoGate, isoLoad, isoMetadata } from '../_lib/gate';
import { mayCall } from '../_lib/may';
import { clientToday } from '../_lib/people';
import { IsoRefusal } from '../_components/IsoStates';
import { isoPath } from '../overview/overview-model';
import {
  kindTabs,
  riskExportQuery,
  riskFilterDefs,
  riskFilters,
  riskFilterValue,
  riskRows,
  risksQuery,
} from './risks-model';
import { RisksView } from './RisksView';

type Props = {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const TITLE = 'Risks';

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return isoMetadata((await params).clientId, TITLE);
}

// The risk register (packages.md ISO-6b): risks, opportunities, aspects and hazards of the client's systems.
export default async function IsoRisksPage({ params, searchParams }: Props) {
  const { clientId } = await params;
  const gate = await isoGate(clientId);
  if (!gate.on) return null;
  const search = await searchParams;
  const api = await serverApi();
  const loaded = await isoLoad(async () => {
    const systemList = await systems(api, clientId);
    const filters = riskFilters(
      search,
      systemList.map((s) => s.id),
    );
    const [risks, unitList, peopleList] = await Promise.all([
      allPages(
        async (query) =>
          (
            await api.call('listIsoRisks', {
              params: { clientId },
              query: { ...risksQuery(filters), ...query },
            })
          ).data,
      ),
      units(api, clientId),
      people(api, clientId),
    ]);
    return { systemList, filters, risks, unitList, peopleList };
  });
  if (!loaded.ok) {
    return <IsoRefusal refusal={loaded.refusal} title={TITLE} homeHref={gate.homeHref} />;
  }
  const { systemList, filters, risks, unitList, peopleList } = loaded.data;
  const header = (
    <PageHeader
      title={TITLE}
      description="The risk register: risks and opportunities, environmental aspects and hazards, with their controls and treatment."
    />
  );
  if (systemList.length === 0) {
    return (
      <>
        {header}
        <PageEmpty
          title="No management system yet"
          body="The risk register belongs to a management system. Set one up on the ISO overview first."
          action={{ label: 'Go to ISO overview', href: isoPath(clientId, 'overview') }}
        />
      </>
    );
  }
  const unitOptions = unitList
    .filter((u) => u.archivedAt === null)
    .map((u) => ({ id: u.id, name: u.name }));
  const create = mayCall('createIsoRisk', gate.roles, true)
    ? {
        systems: systemList.map((s) => ({ id: s.id, name: s.name, unitIds: s.unitIds })),
        units: unitOptions,
        people: peopleList,
        ownerOnly: mayCall('createIsoRisk', gate.roles) ? null : gate.personId,
        today: clientToday(gate.client.timeZone),
      }
    : null;
  const path = isoPath(clientId, 'risks');

  return (
    <>
      {header}
      <RisksView
        clientId={clientId}
        rows={riskRows(risks, unitList, peopleList)}
        tabs={kindTabs(path, filters)}
        kind={filters.kind}
        filters={riskFilterDefs()}
        filterValue={riskFilterValue(filters)}
        fromOverview={filters.ids.length > 0}
        clearHref={path}
        exportFilters={new URLSearchParams(riskExportQuery(filters)).toString()}
        create={create}
      />
    </>
  );
}
