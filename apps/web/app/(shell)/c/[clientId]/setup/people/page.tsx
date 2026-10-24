import type { Person } from '@canopy/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { isApiError } from '../../../../../../lib/api/client';
import { redirectIfSignedOut } from '../../overview/signed-out';
import { serverApi } from '../../../../../../lib/api/server';
import { NoPermission, PageHeader } from '../../../../../../lib/patterns';
import { routeByPath, visibleTo } from '../../../../../../lib/routes';
import { homeHref } from '../../../../../../lib/shell/model';
import { loadShell } from '../../../../../../lib/shell/server';
import { PeopleView } from './PeopleView';
import { personRows } from './people-model';

type Props = { params: Promise<{ clientId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { clientId } = await params;
  const client = (await loadShell()).clients.find((c) => c.id === clientId);
  return { title: ['People', client?.name].filter(Boolean).join(' · ') };
}

const MAX_PAGES = 10;

// Setup: the client's people (MODULES.md M13 "setup screens"). Up to 2,000 are listed, which covers a client's
// owners and approvers; merging needs them on screen.
export default async function PeoplePage({ params }: Props) {
  const { clientId } = await params;
  const model = await loadShell();
  const client = model.clients.find((c) => c.id === clientId);
  if (!client) notFound();
  // Owners and approvers can read the list through the API but change none of it, so the page is not theirs.
  if (!visibleTo(routeByPath('setup/people'), model.roles.byClient[clientId] ?? [])) {
    return (
      <NoPermission what="people" backHref={`/c/${clientId}/overview`} backLabel="Go to overview" />
    );
  }
  const api = await serverApi();

  const people: Person[] = [];
  try {
    let cursor: string | null = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page: { items: Person[]; nextCursor: string | null } = (
        await api.call('listClientPeople', {
          params: { clientId },
          query: { limit: '200', ...(cursor ? { cursor } : {}) },
        })
      ).data;
      people.push(...page.items);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
  } catch (error) {
    await redirectIfSignedOut(error);
    if (isApiError(error, 'FORBIDDEN', 'ACCESS_EXPIRED')) {
      return <NoPermission what="people" backHref={homeHref(model)} backLabel="Go to home" />;
    }
    throw error;
  }

  return (
    <>
      <PageHeader
        title="People"
        description={`${client.name}'s owners, approvers and client admins.`}
      />
      <PeopleView clientId={clientId} rows={personRows(people)} />
    </>
  );
}
