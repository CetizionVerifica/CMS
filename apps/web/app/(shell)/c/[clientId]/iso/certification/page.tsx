import type { Metadata } from 'next';

import { serverApi } from '../../../../../../lib/api/server';
import { PageEmpty, PageHeader } from '../../../../../../lib/patterns';
import { allPages, clauses, people, standards, systems, units } from '../_lib/data';
import { isoGate, isoLoad, isoMetadata } from '../_lib/gate';
import { mayCall } from '../_lib/may';
import { clientToday, first, listParam } from '../_lib/people';
import { IsoRefusal } from '../_components/IsoStates';
import { clauseOptions } from '../documents/documents-model';
import { isoPath } from '../overview/overview-model';
import { Certificates } from './Certificates';
import { ExternalAudits } from './ExternalAudits';

type Props = {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const TITLE = 'Certification';

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return isoMetadata((await params).clientId, TITLE);
}

// Certificates and certification body visits (packages.md ISO-6a). `?ids=` narrows the certificates to the ones an
// overview number counted; `?audit=` opens a visit.
export default async function IsoCertificationPage({ params, searchParams }: Props) {
  const { clientId } = await params;
  const gate = await isoGate(clientId);
  if (!gate.on) return null;
  const search = await searchParams;
  const api = await serverApi();
  const loaded = await isoLoad(async () => {
    const [systemList, standardList, unitList, clauseList, peopleList, certs, audits] =
      await Promise.all([
        systems(api, clientId),
        standards(api, clientId),
        units(api, clientId),
        clauses(api, clientId),
        people(api, clientId),
        allPages(
          async (query) =>
            (await api.call('listIsoCertifications', { params: { clientId }, query })).data,
        ),
        allPages(
          async (query) =>
            (await api.call('listIsoExternalAudits', { params: { clientId }, query })).data,
        ),
      ]);
    return { systemList, standardList, unitList, clauseList, peopleList, certs, audits };
  });
  if (!loaded.ok) {
    return <IsoRefusal refusal={loaded.refusal} title={TITLE} homeHref={gate.homeHref} />;
  }
  const { systemList, standardList, unitList, clauseList, peopleList, certs, audits } = loaded.data;
  const header = (
    <PageHeader
      title={TITLE}
      description="Certificates the client holds or is working towards, and the certification body's visits."
    />
  );
  if (systemList.length === 0) {
    return (
      <>
        {header}
        <PageEmpty
          title="No management system yet"
          body="Certificates belong to a management system. Set one up on the ISO overview first."
          action={{ label: 'Go to ISO overview', href: isoPath(clientId, 'overview') }}
        />
      </>
    );
  }
  const systemOptions = systemList.map((s) => ({
    id: s.id,
    name: s.name,
    standardIds: s.standardIds,
    unitIds: s.unitIds,
  }));
  const unitOptions = unitList
    .filter((u) => u.archivedAt === null)
    .map((u) => ({ id: u.id, name: u.name }));
  const canManage = mayCall('updateIsoCertification', gate.roles);
  const today = clientToday(gate.client.timeZone);

  return (
    <>
      {header}
      <div className="flex flex-col gap-8">
        <Certificates
          clientId={clientId}
          certificates={certs}
          standards={standardList}
          systems={systemOptions}
          units={unitOptions}
          ids={listParam(search.ids)}
          clearHref={isoPath(clientId, 'certification')}
          canManage={canManage}
          today={today}
        />
        <ExternalAudits
          clientId={clientId}
          audits={audits}
          standards={standardList}
          systems={systemOptions}
          units={unitOptions}
          people={peopleList}
          clauseOptions={Object.fromEntries(
            systemList.map((s) => [s.id, clauseOptions(clauseList, standardList, s.standardIds)]),
          )}
          openAuditId={first(search.audit) ?? null}
          canManage={mayCall('updateIsoExternalAudit', gate.roles)}
          today={today}
          timeZone={gate.client.timeZone}
        />
      </div>
    </>
  );
}
