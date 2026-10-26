import { Id } from '@canopy/contracts';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';

import { serverApi } from '../../../../../../../lib/api/server';
import { PageHeader } from '../../../../../../../lib/patterns';
import { allPages, people, systems, units } from '../../_lib/data';
import { isoGate, isoLoad, isoMetadata } from '../../_lib/gate';
import { mayCall } from '../../_lib/may';
import { clientToday } from '../../_lib/people';
import { word } from '../../_lib/words';
import { IsoRefusal } from '../../_components/IsoStates';
import { isoPath } from '../../overview/overview-model';
import { RiskRecord } from './RiskRecord';

type Props = { params: Promise<{ clientId: string; riskId: string }> };

const TITLE = 'Risks';

// The title names the item only when the add-on is on and the person can read it.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { clientId, riskId } = await params;
  const base = await isoMetadata(clientId, TITLE);
  const gate = await isoGate(clientId);
  if (!gate.on || !Id.safeParse(riskId).success) return base;
  const api = await serverApi();
  const risk = await api
    .call('getIsoRisk', { params: { clientId, id: riskId } })
    .then((r) => r.data)
    .catch(() => null);
  return risk
    ? { title: `${word('RiskKind', risk.kind)}: ${risk.activity} · ${gate.client.name}` }
    : base;
}

export default async function IsoRiskPage({ params }: Props) {
  const { clientId, riskId } = await params;
  const gate = await isoGate(clientId);
  if (!gate.on) return null;
  if (!Id.safeParse(riskId).success) notFound();
  const api = await serverApi();
  const loaded = await isoLoad(async () => {
    const [risk, controls, actions, systemList, unitList, peopleList] = await Promise.all([
      api.call('getIsoRisk', { params: { clientId, id: riskId } }).then((r) => r.data),
      api
        .call('listIsoRiskControls', { params: { clientId, id: riskId } })
        .then((r) => r.data.items),
      allPages(
        async (query) =>
          (
            await api.call('listIsoActions', {
              params: { clientId },
              query: { subjectType: 'RISK_ITEM', subjectId: riskId, ...query },
            })
          ).data,
      ),
      systems(api, clientId),
      units(api, clientId),
      people(api, clientId),
    ]);
    return { risk, controls, actions, systemList, unitList, peopleList };
  });
  if (!loaded.ok) {
    return <IsoRefusal refusal={loaded.refusal} title={TITLE} homeHref={gate.homeHref} />;
  }
  const { risk, controls, actions, systemList, unitList, peopleList } = loaded.data;
  const system = systemList.find((s) => s.id === risk.managementSystemId);
  const owner = risk.ownerId === gate.personId;
  const unitOptions = unitList
    .filter(
      (u) => u.archivedAt === null && (!system?.unitIds.length || system.unitIds.includes(u.id)),
    )
    .map((u) => ({ id: u.id, name: u.name }));

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-2 text-meta">
        <NextLink
          href={isoPath(clientId, 'risks')}
          prefetch={false}
          className="text-forest underline"
        >
          Risk register
        </NextLink>
      </nav>
      <PageHeader
        title={risk.description}
        description={`${word('RiskKind', risk.kind)} · ${risk.activity}`}
      />
      <RiskRecord
        clientId={clientId}
        risk={risk}
        controls={controls}
        actions={actions}
        people={peopleList}
        units={unitOptions}
        unitName={
          risk.unitId
            ? (unitList.find((u) => u.id === risk.unitId)?.name ?? 'Unknown unit')
            : "All the system's units"
        }
        systemName={system?.name ?? 'Unknown system'}
        canEdit={mayCall('updateIsoRisk', gate.roles, owner)}
        canReassign={mayCall('updateIsoRisk', gate.roles)}
        canOverride={mayCall('setIsoRiskSignificance', gate.roles)}
        canAddAction={mayCall('createIsoAction', gate.roles, owner)}
        actionEditing={{ all: mayCall('updateIsoAction', gate.roles), personId: gate.personId }}
        today={clientToday(gate.client.timeZone)}
      />
    </>
  );
}
