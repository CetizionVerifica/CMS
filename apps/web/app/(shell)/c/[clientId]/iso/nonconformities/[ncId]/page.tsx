import { Id, type NonconformityView } from '@canopy/contracts';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';

import type { ApiClient } from '../../../../../../../lib/api/client';
import { serverApi } from '../../../../../../../lib/api/server';
import { PageHeader } from '../../../../../../../lib/patterns';
import { allPages, clauses, people, standards, systems, units } from '../../_lib/data';
import { isoGate, isoLoad, isoMetadata } from '../../_lib/gate';
import { mayCall } from '../../_lib/may';
import { clientToday } from '../../_lib/people';
import { word } from '../../_lib/words';
import { IsoRefusal } from '../../_components/IsoStates';
import { isoPath } from '../../overview/overview-model';
import { ncName, ncSummary, ncSystems } from '../nc-model';
import { NcRecord, type LinkedRecord } from './NcRecord';

type Props = { params: Promise<{ clientId: string; ncId: string }> };

const TITLE = 'Nonconformities';

// The title names the record only when the add-on is on and the person can read it.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { clientId, ncId } = await params;
  const base = await isoMetadata(clientId, TITLE);
  const gate = await isoGate(clientId);
  if (!gate.on || !Id.safeParse(ncId).success) return base;
  const api = await serverApi();
  const nc = await api
    .call('getIsoNonconformity', { params: { clientId, id: ncId } })
    .then((r) => r.data)
    .catch(() => null);
  return nc ? { title: `${ncName(nc)} · ${gate.client.name}` } : base;
}

/** A register instance by name with its link, or null when the person may not open it (or it is gone). */
async function instance(
  api: ApiClient,
  clientId: string,
  id: string | null,
): Promise<LinkedRecord | null> {
  if (!id) return null;
  const found = await api
    .call('getInstance', { params: { id } })
    .then((r) => r.data)
    .catch(() => null);
  return found
    ? {
        id,
        label: `${found.title} · ${found.unitName}`,
        due: found.dueDate,
        href: `/c/${clientId}/register/${id}`,
      }
    : { id, label: 'A register activity you cannot open', href: null };
}

/** The audit finding that raised it: which audit, linked where that audit's page is. */
async function finding(
  api: ApiClient,
  clientId: string,
  nc: NonconformityView,
): Promise<LinkedRecord | null> {
  if (!nc.findingId) return null;
  const params = { clientId };
  if (nc.source === 'EXTERNAL_AUDIT') {
    const audits = await allPages(
      async (query) =>
        (
          await api.call('listIsoExternalAudits', {
            params,
            query: { managementSystemId: nc.managementSystemId, ...query },
          })
        ).data,
    );
    for (const a of audits) {
      const found = await api
        .call('listIsoExternalFindings', { params: { clientId, id: a.id } })
        .then((r) => r.data.items.some((f) => f.id === nc.findingId))
        .catch(() => false);
      if (found) {
        return {
          id: a.id,
          label: `A finding of the ${word('ExternalAuditType', a.type).toLowerCase()} audit by ${a.body}`,
          href: `${isoPath(clientId, 'certification')}?audit=${a.id}`,
        };
      }
    }
  }
  return { id: nc.findingId, label: 'An internal audit finding', href: null };
}

export default async function IsoNonconformityPage({ params }: Props) {
  const { clientId, ncId } = await params;
  const gate = await isoGate(clientId);
  if (!gate.on) return null;
  if (!Id.safeParse(ncId).success) notFound();
  const api = await serverApi();
  const loaded = await isoLoad(async () => {
    const nc = (await api.call('getIsoNonconformity', { params: { clientId, id: ncId } })).data;
    const [
      actions,
      systemList,
      unitList,
      peopleList,
      standardList,
      clauseList,
      risks,
      documents,
      sourceInstance,
      statutory,
      raisedBy,
    ] = await Promise.all([
      allPages(
        async (query) =>
          (
            await api.call('listIsoActions', {
              params: { clientId },
              query: { subjectType: 'NONCONFORMITY', subjectId: ncId, ...query },
            })
          ).data,
      ),
      systems(api, clientId),
      units(api, clientId),
      people(api, clientId),
      standards(api, clientId),
      clauses(api, clientId),
      allPages(
        async (query) =>
          (
            await api.call('listIsoRisks', {
              params: { clientId },
              query: {
                managementSystemId: nc.managementSystemId,
                includeArchived: 'true',
                ...query,
              },
            })
          ).data,
      ),
      allPages(
        async (query) =>
          (
            await api.call('listIsoDocuments', {
              params: { clientId },
              query: {
                managementSystemId: nc.managementSystemId,
                status: 'ACTIVE,OBSOLETE',
                ...query,
              },
            })
          ).data,
      ),
      instance(api, clientId, nc.sourceInstanceId),
      instance(api, clientId, nc.incident?.statutoryInstanceId ?? null),
      finding(api, clientId, nc),
    ]);
    return {
      nc,
      actions,
      systemList,
      unitList,
      peopleList,
      standardList,
      clauseList,
      risks,
      documents,
      sourceInstance,
      statutory,
      raisedBy,
    };
  });
  if (!loaded.ok) {
    return <IsoRefusal refusal={loaded.refusal} title={TITLE} homeHref={gate.homeHref} />;
  }
  const d = loaded.data;
  const { nc } = d;
  const system = d.systemList.find((s) => s.id === nc.managementSystemId);
  const owner = nc.ownerId === gate.personId;
  const [option] = system ? ncSystems([system], d.standardList, d.clauseList, d.risks) : [];
  const riskLinks: LinkedRecord[] = d.risks.map((r) => ({
    id: r.id,
    label: `${word('RiskKind', r.kind)}: ${r.activity}`,
    href: `${isoPath(clientId, 'risks')}/${r.id}`,
  }));
  const documentLinks: LinkedRecord[] = d.documents.map((doc) => ({
    id: doc.id,
    label: `${doc.code} ${doc.title}`,
    href: `${isoPath(clientId, 'documents')}/${doc.id}`,
  }));

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-2 text-meta">
        <NextLink
          href={isoPath(clientId, 'nonconformities')}
          prefetch={false}
          className="text-forest underline"
        >
          Nonconformity log
        </NextLink>
      </nav>
      <PageHeader
        title={ncSummary(nc.description)}
        description={`${ncName(nc)} · ${word('NcSource', nc.source)} · ${word('NcSeverity', nc.severity)}`}
      />
      <NcRecord
        clientId={clientId}
        nc={nc}
        actions={d.actions}
        people={d.peopleList}
        units={d.unitList
          .filter(
            (u) =>
              u.archivedAt === null && (!system?.unitIds.length || system.unitIds.includes(u.id)),
          )
          .map((u) => ({ id: u.id, name: u.name }))}
        unitName={
          nc.unitId
            ? (d.unitList.find((u) => u.id === nc.unitId)?.name ?? 'Unknown unit')
            : 'No one unit'
        }
        systemName={system?.name ?? 'Unknown system'}
        system={option ?? null}
        standards={d.standardList}
        risks={riskLinks}
        liveRiskIds={d.risks.filter((r) => r.archivedAt === null).map((r) => r.id)}
        documents={documentLinks}
        sourceInstance={d.sourceInstance}
        statutory={d.statutory}
        raisedBy={d.raisedBy}
        raisedFromRisk={riskLinks.find((r) => r.id === nc.raisedFromRiskItemId) ?? null}
        canEdit={mayCall('updateIsoNonconformity', gate.roles, owner)}
        canReassign={mayCall('reassignIsoNonconformity', gate.roles)}
        canAddAction={mayCall('createIsoAction', gate.roles, owner)}
        actionEditing={{ all: mayCall('updateIsoAction', gate.roles), personId: gate.personId }}
        today={clientToday(gate.client.timeZone)}
        timeZone={gate.client.timeZone}
      />
    </>
  );
}
