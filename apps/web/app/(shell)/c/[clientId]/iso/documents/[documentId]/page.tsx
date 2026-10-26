import { Id } from '@canopy/contracts';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';

import { serverApi } from '../../../../../../../lib/api/server';
import { PageHeader } from '../../../../../../../lib/patterns';
import { clauses, people, standards, systems } from '../../_lib/data';
import { isoGate, isoLoad, isoMetadata } from '../../_lib/gate';
import { mayCall } from '../../_lib/may';
import { clientToday } from '../../_lib/people';
import { IsoRefusal } from '../../_components/IsoStates';
import { isoPath } from '../../overview/overview-model';
import { clauseOptions } from '../documents-model';
import { DocumentRecord } from './DocumentRecord';

type Props = { params: Promise<{ clientId: string; documentId: string }> };

const TITLE = 'Documents';

// The title names the document only when the add-on is on and the person can read it; otherwise it says no more than
// the list's own title does.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { clientId, documentId } = await params;
  const base = await isoMetadata(clientId, TITLE);
  const gate = await isoGate(clientId);
  if (!gate.on || !Id.safeParse(documentId).success) return base;
  const api = await serverApi();
  const doc = await api
    .call('getIsoDocument', { params: { clientId, id: documentId } })
    .then((r) => r.data)
    .catch(() => null);
  return doc ? { title: `${doc.code} ${doc.title} · ${gate.client.name}` } : base;
}

export default async function IsoDocumentPage({ params }: Props) {
  const { clientId, documentId } = await params;
  const gate = await isoGate(clientId);
  if (!gate.on) return null;
  if (!Id.safeParse(documentId).success) notFound();
  const api = await serverApi();
  const loaded = await isoLoad(async () => {
    const [doc, revisions, systemList, standardList, clauseList, peopleList] = await Promise.all([
      api.call('getIsoDocument', { params: { clientId, id: documentId } }).then((r) => r.data),
      api
        .call('listIsoRevisions', { params: { clientId, id: documentId } })
        .then((r) => r.data.items),
      systems(api, clientId),
      standards(api, clientId),
      clauses(api, clientId),
      people(api, clientId),
    ]);
    return { doc, revisions, systemList, standardList, clauseList, peopleList };
  });
  if (!loaded.ok) {
    return <IsoRefusal refusal={loaded.refusal} title={TITLE} homeHref={gate.homeHref} />;
  }
  const { doc, revisions, systemList, standardList, clauseList, peopleList } = loaded.data;
  const system = systemList.find((s) => s.id === doc.managementSystemId);
  const owner = doc.ownerId === gate.personId;

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-2 text-meta">
        <NextLink
          href={isoPath(clientId, 'documents')}
          prefetch={false}
          className="text-forest underline"
        >
          Documents
        </NextLink>
      </nav>
      <PageHeader title={`${doc.code} ${doc.title}`} />
      <DocumentRecord
        clientId={clientId}
        doc={doc}
        revisions={revisions}
        people={peopleList}
        clauseOptions={clauseOptions(clauseList, standardList, system?.standardIds ?? [])}
        systemName={system?.name ?? 'Unknown system'}
        canEdit={mayCall('updateIsoDocument', gate.roles, owner)}
        canReassign={mayCall('updateIsoDocument', gate.roles)}
        canEditDraft={mayCall('updateIsoRevision', gate.roles, owner)}
        today={clientToday(gate.client.timeZone)}
        timeZone={gate.client.timeZone}
      />
    </>
  );
}
