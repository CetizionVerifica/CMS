import type { Metadata } from 'next';

import { serverApi } from '../../../../../../lib/api/server';
import { PageHeader } from '../../../../../../lib/patterns';
import { allPages, people, systems } from '../_lib/data';
import { isoGate, isoLoad, isoMetadata } from '../_lib/gate';
import { mayCall } from '../_lib/may';
import { clientToday, first } from '../_lib/people';
import { IsoRefusal } from '../_components/IsoStates';
import {
  actionFilterDefs,
  actionFilters,
  actionFilterValue,
  actionsQuery,
  actionSubjects,
  bySubjectType,
} from './actions-model';
import { ActionsView } from './ActionsView';

type Props = {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const TITLE = 'Actions';

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return isoMetadata((await params).clientId, TITLE);
}

// Every ISO action (packages.md ISO-6b): filter by what it is for, owner and state; `?action=` opens one.
export default async function IsoActionsPage({ params, searchParams }: Props) {
  const { clientId } = await params;
  const gate = await isoGate(clientId);
  if (!gate.on) return null;
  const search = await searchParams;
  const api = await serverApi();
  const loaded = await isoLoad(async () => {
    const systemList = await systems(api, clientId);
    const filters = actionFilters(
      search,
      systemList.map((s) => s.id),
    );
    // Risk items and objectives name the actions on them. Every role that lists actions lists both; a subject missing from
    // them (archived out of the list, or deleted) is named by its kind only.
    const [actions, risks, objectives, peopleList] = await Promise.all([
      allPages(
        async (query) =>
          (
            await api.call('listIsoActions', {
              params: { clientId },
              query: { ...actionsQuery(filters), ...query },
            })
          ).data,
      ),
      allPages(
        async (query) => (await api.call('listIsoRisks', { params: { clientId }, query })).data,
      ),
      allPages(
        async (query) =>
          (await api.call('listIsoObjectives', { params: { clientId }, query })).data,
      ),
      people(api, clientId),
    ]);
    return { filters, actions: bySubjectType(actions, filters), risks, objectives, peopleList };
  });
  if (!loaded.ok) {
    return <IsoRefusal refusal={loaded.refusal} title={TITLE} homeHref={gate.homeHref} />;
  }
  const { filters, actions, risks, objectives, peopleList } = loaded.data;

  return (
    <>
      <PageHeader
        title={TITLE}
        description="Corrective, treatment, improvement and review actions and objective plans, with their owners and due dates."
      />
      <ActionsView
        clientId={clientId}
        actions={actions}
        subjects={actionSubjects(clientId, actions, risks, objectives)}
        people={peopleList}
        filters={actionFilterDefs()}
        filterValue={actionFilterValue(filters)}
        openActionId={first(search.action) ?? null}
        editing={{ all: mayCall('updateIsoAction', gate.roles), personId: gate.personId }}
        today={clientToday(gate.client.timeZone)}
      />
    </>
  );
}
