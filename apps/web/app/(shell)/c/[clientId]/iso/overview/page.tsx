import type { Metadata } from 'next';

import { serverApi } from '../../../../../../lib/api/server';
import { PageEmpty, PageHeader } from '../../../../../../lib/patterns';
import { clauses, standards, systems, units } from '../_lib/data';
import { isoGate, isoLoad, isoMetadata } from '../_lib/gate';
import { mayCall } from '../_lib/may';
import { clientToday } from '../_lib/people';
import { IsoRefusal } from '../_components/IsoStates';
import { MyActionsCard, SystemOverview } from './OverviewView';
import { NewSystem, SystemSetup } from './SystemSetup';

type Props = { params: Promise<{ clientId: string }> };

const TITLE = 'ISO overview';

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return isoMetadata((await params).clientId, TITLE);
}

// The client's ISO overview and its management systems' set-up (packages.md ISO-6a).
export default async function IsoOverviewPage({ params }: Props) {
  const { clientId } = await params;
  const gate = await isoGate(clientId);
  if (!gate.on) return null;
  const api = await serverApi();
  const loaded = await isoLoad(async () => {
    const [overview, systemList, standardList, unitList, clauseList, defs] = await Promise.all([
      api.call('getIsoOverview', { params: { clientId } }).then((r) => r.data),
      systems(api, clientId),
      standards(api, clientId),
      units(api, clientId),
      clauses(api, clientId),
      api.call('listIsoReviewDefs', { params: { clientId } }).then((r) => r.data),
    ]);
    const contexts = await Promise.all(
      systemList.map((s) =>
        api
          .call('listIsoContextItems', { params: { clientId, id: s.id } })
          .then((r) => [s.id, r.data.items] as const),
      ),
    );
    return {
      overview,
      systemList,
      standardList,
      unitList,
      clauseList,
      defs,
      contexts: Object.fromEntries(contexts),
    };
  });
  if (!loaded.ok) {
    return <IsoRefusal refusal={loaded.refusal} title={TITLE} homeHref={gate.homeHref} />;
  }
  const { overview, systemList, standardList, unitList, clauseList, defs, contexts } = loaded.data;
  const canSetUp = mayCall('updateIsoSystem', gate.roles);
  const unitOptions = unitList
    .filter((u) => u.archivedAt === null)
    .map((u) => ({ id: u.id, name: u.name }));
  const unitNames = Object.fromEntries(unitList.map((u) => [u.id, u.name]));
  const clauseNumbers = Object.fromEntries(
    clauseList.map((c) => [
      c.id,
      `${standardList.find((s) => s.id === c.standardId)?.title ?? ''} ${c.number}`.trim(),
    ]),
  );
  const today = clientToday(gate.client.timeZone);

  return (
    <>
      <PageHeader
        title={TITLE}
        description="Where each management system stands: clause readiness, certification gates and the work that needs someone."
      />
      {systemList.length === 0 ? (
        <div className="flex flex-col gap-4">
          <PageEmpty
            title="No management system yet"
            body={
              canSetUp
                ? 'Set one up with the standards this client works to. Its clause checklist is created with it.'
                : 'Your consultant or client admin sets up the management system.'
            }
          />
          {canSetUp ? (
            <div>
              <NewSystem clientId={clientId} standards={standardList} units={unitOptions} />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          <MyActionsCard clientId={clientId} />
          {systemList.map((system) => {
            const view = overview.systems.find((s) => s.managementSystemId === system.id);
            return (
              <section
                key={system.id}
                aria-labelledby={`system-${system.id}`}
                className="flex flex-col gap-4"
              >
                <h2 id={`system-${system.id}`} className="text-section text-ink">
                  {system.name}
                </h2>
                {view ? (
                  <SystemOverview
                    clientId={clientId}
                    system={view}
                    standards={standardList}
                    missing={{ unitNames, inputDefs: defs.inputs }}
                    clauseNumbers={clauseNumbers}
                  />
                ) : null}
                <SystemSetup
                  clientId={clientId}
                  system={system}
                  standards={standardList}
                  units={unitOptions}
                  contextItems={contexts[system.id] ?? []}
                  canEdit={canSetUp}
                  today={today}
                />
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
