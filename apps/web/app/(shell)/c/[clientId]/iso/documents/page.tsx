import type { Metadata } from 'next';

import { serverApi } from '../../../../../../lib/api/server';
import { PageEmpty, PageHeader } from '../../../../../../lib/patterns';
import { allPages, clauses, people, standards, systems } from '../_lib/data';
import { isoGate, isoLoad, isoMetadata } from '../_lib/gate';
import { mayCall } from '../_lib/may';
import { clientToday } from '../_lib/people';
import { IsoRefusal } from '../_components/IsoStates';
import { isoPath } from '../overview/overview-model';
import {
  clauseOptions,
  documentFilterDefs,
  documentFilters,
  documentRows,
  documentsQuery,
} from './documents-model';
import { DocumentsView } from './DocumentsView';

type Props = {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const TITLE = 'Documents';

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return isoMetadata((await params).clientId, TITLE);
}

// The client's controlled documents (packages.md ISO-6a). Active documents unless the status filter says otherwise.
export default async function IsoDocumentsPage({ params, searchParams }: Props) {
  const { clientId } = await params;
  const gate = await isoGate(clientId);
  if (!gate.on) return null;
  const search = await searchParams;
  const api = await serverApi();
  const loaded = await isoLoad(async () => {
    const systemList = await systems(api, clientId);
    const filters = documentFilters(
      search,
      systemList.map((s) => s.id),
    );
    const [docs, standardList, clauseList, peopleList] = await Promise.all([
      allPages(
        async (query) =>
          (
            await api.call('listIsoDocuments', {
              params: { clientId },
              query: { ...documentsQuery(filters), ...query },
            })
          ).data,
      ),
      standards(api, clientId),
      clauses(api, clientId),
      people(api, clientId),
    ]);
    return { systemList, filters, docs, standardList, clauseList, peopleList };
  });
  if (!loaded.ok) {
    return <IsoRefusal refusal={loaded.refusal} title={TITLE} homeHref={gate.homeHref} />;
  }
  const { systemList, filters, docs, standardList, clauseList, peopleList } = loaded.data;
  const header = (
    <PageHeader
      title={TITLE}
      description="Controlled documents: the revision in force, who owns and approves it, and when it is next reviewed."
    />
  );
  if (systemList.length === 0) {
    return (
      <>
        {header}
        <PageEmpty
          title="No management system yet"
          body="Documents belong to a management system. Set one up on the ISO overview first."
          action={{ label: 'Go to ISO overview', href: isoPath(clientId, 'overview') }}
        />
      </>
    );
  }
  const canCreate = mayCall('createIsoDocument', gate.roles, true);
  const create = canCreate
    ? {
        systems: systemList.map((s) => ({ id: s.id, name: s.name })),
        clauseOptions: Object.fromEntries(
          systemList.map((s) => [s.id, clauseOptions(clauseList, standardList, s.standardIds)]),
        ),
        people: peopleList,
        ownerOnly: mayCall('createIsoDocument', gate.roles) ? null : gate.personId,
        today: clientToday(gate.client.timeZone),
      }
    : null;

  return (
    <>
      {header}
      <DocumentsView
        clientId={clientId}
        rows={documentRows(docs, peopleList)}
        filters={documentFilterDefs()}
        filterValue={{
          type: filters.type,
          status: filters.status,
          ownerId: filters.ownerId ? [filters.ownerId] : [],
        }}
        fromOverview={filters.ids.length > 0}
        clearHref={isoPath(clientId, 'documents')}
        create={create}
      />
    </>
  );
}
