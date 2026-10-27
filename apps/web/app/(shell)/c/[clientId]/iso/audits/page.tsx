import type { Metadata } from 'next';

import { serverApi } from '../../../../../../lib/api/server';
import { PageEmpty, PageHeader } from '../../../../../../lib/patterns';
import { allPages, clauses, people, standards, systems, units } from '../_lib/data';
import { isoGate, isoLoad, isoMetadata } from '../_lib/gate';
import { mayCall } from '../_lib/may';
import { clientToday } from '../_lib/people';
import { standardTitle } from '../_lib/words';
import { IsoRefusal } from '../_components/IsoStates';
import { clauseOptions } from '../documents/documents-model';
import { isoPath } from '../overview/overview-model';
import {
  auditFilterDefs,
  auditFilters,
  auditFilterValue,
  auditRows,
  auditsQuery,
  programmeFys,
  programmeOptions,
} from './audit-model';
import { AuditsView } from './AuditsView';

type Props = {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const TITLE = 'Audits';

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return isoMetadata((await params).clientId, TITLE);
}

// The audit programme and its internal audits (packages.md ISO-6c, model §3.7): each FY's programme with its coverage,
// and the audits, filtered by the API.
export default async function IsoAuditsPage({ params, searchParams }: Props) {
  const { clientId } = await params;
  const gate = await isoGate(clientId);
  if (!gate.on) return null;
  const search = await searchParams;
  const api = await serverApi();
  const mayPlan = mayCall('createIsoInternalAudit', gate.roles);
  const loaded = await isoLoad(async () => {
    const [systemList, programmes, unitList, peopleList, standardList, clauseList] =
      await Promise.all([
        systems(api, clientId),
        allPages(
          async (query) =>
            (await api.call('listIsoAuditProgrammes', { params: { clientId }, query })).data,
        ),
        units(api, clientId),
        people(api, clientId),
        standards(api, clientId),
        clauses(api, clientId),
      ]);
    const filters = auditFilters(
      search,
      systemList.map((s) => s.id),
      unitList.map((u) => u.id),
    );
    const query = auditsQuery(filters, programmes);
    const audits = query
      ? await allPages(
          async (page) =>
            (
              await api.call('listIsoInternalAudits', {
                params: { clientId },
                query: { ...query, ...page },
              })
            ).data,
        )
      : [];
    return {
      systemList,
      programmes,
      unitList,
      peopleList,
      standardList,
      clauseList,
      filters,
      audits,
    };
  });
  if (!loaded.ok) {
    return <IsoRefusal refusal={loaded.refusal} title={TITLE} homeHref={gate.homeHref} />;
  }
  const {
    systemList,
    programmes,
    unitList,
    peopleList,
    standardList,
    clauseList,
    filters,
    audits,
  } = loaded.data;
  const header = (
    <PageHeader
      title={TITLE}
      description="The audit programme for each financial year, how much of the system it covers, and the internal audits in it."
    />
  );
  if (systemList.length === 0) {
    return (
      <>
        {header}
        <PageEmpty
          title="No management system yet"
          body="Internal audits belong to a management system. Set one up on the ISO overview first."
          action={{ label: 'Go to ISO overview', href: isoPath(clientId, 'overview') }}
        />
      </>
    );
  }
  const fy = gate.client.thisPeriod.fy;
  const clauseNumber = (id: string) => {
    const c = clauseList.find((x) => x.id === id);
    return c ? `${standardTitle(standardList, c.standardId)} ${c.number}` : 'A clause';
  };
  const live = unitList.filter((u) => u.archivedAt === null);

  return (
    <>
      {header}
      <AuditsView
        clientId={clientId}
        fy={fy}
        programmes={programmes.map((p) => {
          const system = systemList.find((s) => s.id === p.managementSystemId);
          return {
            programme: p,
            systemName: systemList.length > 1 ? (system?.name ?? 'Unknown system') : null,
            uncoveredClauses: p.coverage.uncoveredClauseIds.map(clauseNumber),
            uncoveredUnits: p.coverage.uncoveredUnitIds.map(
              (id) => unitList.find((u) => u.id === id)?.name ?? 'Unknown unit',
            ),
          };
        })}
        missingProgrammes={systemList
          .filter((s) => !programmes.some((p) => p.managementSystemId === s.id && p.fy === fy))
          .map((s) => ({ id: s.id, name: s.name }))}
        canManageProgrammes={mayCall('createIsoAuditProgramme', gate.roles)}
        rows={auditRows(audits, programmes, unitList, peopleList)}
        filters={auditFilterDefs(live, programmeFys(programmes, fy))}
        filterValue={auditFilterValue(filters)}
        fromOverview={filters.ids.length > 0}
        clearHref={isoPath(clientId, 'audits')}
        plan={
          mayPlan
            ? {
                clientId,
                programmes: programmeOptions(programmes, systemList),
                systems: systemList.map((s) => ({
                  id: s.id,
                  unitIds: s.unitIds,
                  clauses: clauseOptions(clauseList, standardList, s.standardIds),
                })),
                units: live.map((u) => ({ id: u.id, name: u.name })),
                people: peopleList,
                today: clientToday(gate.client.timeZone),
              }
            : null
        }
      />
    </>
  );
}
