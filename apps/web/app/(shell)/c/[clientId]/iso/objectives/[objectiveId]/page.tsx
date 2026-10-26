import { Id } from '@canopy/contracts';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';

import { serverApi } from '../../../../../../../lib/api/server';
import { PageHeader } from '../../../../../../../lib/patterns';
import { allPages, people, standards, systems } from '../../_lib/data';
import { isoGate, isoLoad, isoMetadata } from '../../_lib/gate';
import { mayCall } from '../../_lib/may';
import { clientToday } from '../../_lib/people';
import { IsoRefusal } from '../../_components/IsoStates';
import { isoPath } from '../../overview/overview-model';
import { objectiveSystems } from '../objectives-model';
import { ObjectiveRecord } from './ObjectiveRecord';

type Props = { params: Promise<{ clientId: string; objectiveId: string }> };

const TITLE = 'Objectives';

// The title names the objective only when the add-on is on and the person can read it.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { clientId, objectiveId } = await params;
  const base = await isoMetadata(clientId, TITLE);
  const gate = await isoGate(clientId);
  if (!gate.on || !Id.safeParse(objectiveId).success) return base;
  const api = await serverApi();
  const objective = await api
    .call('getIsoObjective', { params: { clientId, id: objectiveId } })
    .then((r) => r.data)
    .catch(() => null);
  return objective
    ? { title: `Objective: ${objective.text.slice(0, 60)} · ${gate.client.name}` }
    : base;
}

export default async function IsoObjectivePage({ params }: Props) {
  const { clientId, objectiveId } = await params;
  const gate = await isoGate(clientId);
  if (!gate.on) return null;
  if (!Id.safeParse(objectiveId).success) notFound();
  const api = await serverApi();
  const loaded = await isoLoad(async () => {
    const [objective, readings, actions, standardList, systemList, risks, peopleList] =
      await Promise.all([
        api.call('getIsoObjective', { params: { clientId, id: objectiveId } }).then((r) => r.data),
        api
          .call('listIsoReadings', { params: { clientId, id: objectiveId } })
          .then((r) => r.data.items),
        allPages(
          async (query) =>
            (
              await api.call('listIsoActions', {
                params: { clientId },
                query: { subjectType: 'OBJECTIVE', subjectId: objectiveId, ...query },
              })
            ).data,
        ),
        standards(api, clientId),
        systems(api, clientId),
        allPages(
          async (query) => (await api.call('listIsoRisks', { params: { clientId }, query })).data,
        ),
        people(api, clientId),
      ]);
    return { objective, readings, actions, standardList, systemList, risks, peopleList };
  });
  if (!loaded.ok) {
    return <IsoRefusal refusal={loaded.refusal} title={TITLE} homeHref={gate.homeHref} />;
  }
  const { objective, readings, actions, standardList, systemList, risks, peopleList } = loaded.data;
  const owner = objective.ownerId === gate.personId;
  const system = objectiveSystems(
    systemList.filter((s) => s.id === objective.managementSystemId),
    standardList,
    risks,
  )[0];

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-2 text-meta">
        <NextLink
          href={isoPath(clientId, 'objectives')}
          prefetch={false}
          className="text-forest underline"
        >
          Objectives
        </NextLink>
      </nav>
      <PageHeader title={objective.text} description={system?.name ?? 'Unknown system'} />
      <ObjectiveRecord
        clientId={clientId}
        objective={objective}
        readings={readings}
        actions={actions}
        standards={standardList}
        system={system}
        linkedRisks={objective.riskItemIds.map((id) => {
          const r = risks.find((x) => x.id === id);
          return {
            id,
            label: r
              ? `${r.activity}: ${r.description.slice(0, 80)}`
              : 'A risk item you cannot see',
            href: r ? `${isoPath(clientId, 'risks')}/${id}` : null,
          };
        })}
        people={peopleList}
        canEdit={mayCall('updateIsoObjective', gate.roles, owner)}
        canReassign={mayCall('updateIsoObjective', gate.roles)}
        canAddAction={mayCall('createIsoAction', gate.roles, owner)}
        actionEditing={{ all: mayCall('updateIsoAction', gate.roles), personId: gate.personId }}
        today={clientToday(gate.client.timeZone)}
      />
    </>
  );
}
