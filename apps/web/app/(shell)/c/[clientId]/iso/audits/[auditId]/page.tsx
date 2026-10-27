import { Id } from '@canopy/contracts';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';

import { serverApi } from '../../../../../../../lib/api/server';
import { PageHeader } from '../../../../../../../lib/patterns';
import { allPages, clauses, people, standards, systems, units } from '../../_lib/data';
import { isoGate, isoLoad, isoMetadata } from '../../_lib/gate';
import { mayCall } from '../../_lib/may';
import { clientToday } from '../../_lib/people';
import { word } from '../../_lib/words';
import { IsoRefusal } from '../../_components/IsoStates';
import { clauseOptions } from '../../documents/documents-model';
import { isoPath } from '../../overview/overview-model';
import { auditUnits, programmeOptions } from '../audit-model';
import { AuditRecord, type FindingNc } from './AuditRecord';

type Props = { params: Promise<{ clientId: string; auditId: string }> };

const TITLE = 'Audits';

// The title names the audit only when the add-on is on and the person can read it.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { clientId, auditId } = await params;
  const base = await isoMetadata(clientId, TITLE);
  const gate = await isoGate(clientId);
  if (!gate.on || !Id.safeParse(auditId).success) return base;
  const api = await serverApi();
  const audit = await api
    .call('getIsoInternalAudit', { params: { clientId, id: auditId } })
    .then((r) => r.data)
    .catch(() => null);
  return audit ? { title: `${audit.title} · ${gate.client.name}` } : base;
}

// One internal audit (packages.md ISO-6c, model §3.7, §4.3): its plan and team, each step its `allowedActions` lists,
// the checklist, the findings (a nonconformity finding raises its nonconformity), the report and its files.
export default async function IsoInternalAuditPage({ params }: Props) {
  const { clientId, auditId } = await params;
  const gate = await isoGate(clientId);
  if (!gate.on) return null;
  if (!Id.safeParse(auditId).success) notFound();
  const api = await serverApi();
  const p = { params: { clientId, id: auditId } };
  const loaded = await isoLoad(async () => {
    const [
      audit,
      checklist,
      findings,
      programmes,
      systemList,
      unitList,
      peopleList,
      standardList,
      clauseList,
    ] = await Promise.all([
      api.call('getIsoInternalAudit', p).then((r) => r.data),
      api.call('listIsoAuditChecklist', p).then((r) => r.data.items),
      api.call('listIsoInternalFindings', p).then((r) => r.data.items),
      allPages(
        async (query) =>
          (await api.call('listIsoAuditProgrammes', { params: { clientId }, query })).data,
      ),
      systems(api, clientId),
      units(api, clientId),
      people(api, clientId),
      standards(api, clientId),
      clauses(api, clientId),
    ]);
    // The nonconformities the findings raised, for their state and owner: a finding's type moves only while its
    // nonconformity is open, and never by its owner. One the person may not read stays unknown.
    const ncs = await Promise.all(
      findings
        .filter((f) => f.nonconformityId)
        .map((f) =>
          api
            .call('getIsoNonconformity', { params: { clientId, id: f.nonconformityId! } })
            .then((r): FindingNc => ({
              id: r.data.id,
              state: r.data.state,
              ownerId: r.data.ownerId,
            }))
            .catch(() => null),
        ),
    );
    return {
      audit,
      checklist,
      findings,
      programmes,
      systemList,
      unitList,
      peopleList,
      standardList,
      clauseList,
      ncs: ncs.filter((n) => n !== null),
    };
  });
  if (!loaded.ok) {
    return <IsoRefusal refusal={loaded.refusal} title={TITLE} homeHref={gate.homeHref} />;
  }
  const d = loaded.data;
  const { audit } = d;
  const system = d.systemList.find((s) => s.id === audit.managementSystemId);
  const programme = d.programmes.find((x) => x.id === audit.programmeId);
  const named = audit.leadAuditorId === gate.personId || audit.auditorIds.includes(gate.personId);
  const systemClauses = system
    ? clauseOptions(d.clauseList, d.standardList, system.standardIds)
    : [];
  const live = d.unitList.filter((u) => u.archivedAt === null);
  const systemUnits = live.filter((u) => !system?.unitIds.length || system.unitIds.includes(u.id));
  const auditUnitList = audit.unitIds.length
    ? d.unitList.filter((u) => audit.unitIds.includes(u.id))
    : systemUnits;

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-2 text-meta">
        <NextLink
          href={isoPath(clientId, 'audits')}
          prefetch={false}
          className="text-forest underline"
        >
          Audits
        </NextLink>
      </nav>
      <PageHeader
        title={audit.title}
        description={[
          'Internal audit',
          programme ? `FY ${programme.fy}` : null,
          auditUnits(audit, d.unitList),
          word('InternalAuditState', audit.state),
        ]
          .filter(Boolean)
          .join(' · ')}
      />
      <AuditRecord
        clientId={clientId}
        audit={audit}
        checklist={d.checklist}
        findings={d.findings}
        ncs={d.ncs}
        people={d.peopleList}
        units={d.unitList.map((u) => ({ id: u.id, name: u.name }))}
        auditUnits={auditUnitList.map((u) => ({ id: u.id, name: u.name }))}
        clauses={systemClauses}
        personId={gate.personId}
        canEdit={mayCall('updateIsoInternalAudit', gate.roles)}
        canConduct={mayCall('createIsoAuditChecklistItem', gate.roles, named)}
        canEditFindings={mayCall('updateIsoInternalFinding', gate.roles, named)}
        plan={{
          clientId,
          programmes: programmeOptions(d.programmes, d.systemList),
          systems: d.systemList.map((s) => ({
            id: s.id,
            unitIds: s.unitIds,
            clauses: clauseOptions(d.clauseList, d.standardList, s.standardIds),
          })),
          units: live.map((u) => ({ id: u.id, name: u.name })),
          people: d.peopleList,
          today: clientToday(gate.client.timeZone),
        }}
        today={clientToday(gate.client.timeZone)}
        timeZone={gate.client.timeZone}
      />
    </>
  );
}
