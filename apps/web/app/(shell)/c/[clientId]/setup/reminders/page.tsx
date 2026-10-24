import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { isApiError } from '../../../../../../lib/api/client';
import { redirectIfSignedOut } from '../../overview/signed-out';
import { serverApi } from '../../../../../../lib/api/server';
import { NoPermission, PageHeader } from '../../../../../../lib/patterns';
import { routeByPath, visibleTo } from '../../../../../../lib/routes';
import { homeHref } from '../../../../../../lib/shell/model';
import { loadShell } from '../../../../../../lib/shell/server';
import { RemindersForm } from './RemindersForm';

type Props = { params: Promise<{ clientId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { clientId } = await params;
  const client = (await loadShell()).clients.find((c) => c.id === clientId);
  return { title: ['Reminders', client?.name].filter(Boolean).join(' · ') };
}

// Setup: when the client's people are reminded (MODULES.md M13 "setup screens"). M9 sends the reminders from these
// settings; this page only reads and saves them.
export default async function RemindersPage({ params }: Props) {
  const { clientId } = await params;
  const model = await loadShell();
  const client = model.clients.find((c) => c.id === clientId);
  if (!client) notFound();
  // Owners and approvers can read some of this through the API but change none of it, so the page is not theirs.
  if (!visibleTo(routeByPath('setup/reminders'), model.roles.byClient[clientId] ?? [])) {
    return (
      <NoPermission
        what="reminder settings"
        backHref={`/c/${clientId}/overview`}
        backLabel="Go to overview"
      />
    );
  }

  let view;
  try {
    view = (await (await serverApi()).call('getClientSettings', { params: { clientId } })).data;
  } catch (error) {
    await redirectIfSignedOut(error);
    if (isApiError(error, 'FORBIDDEN', 'ACCESS_EXPIRED')) {
      return (
        <NoPermission what="reminder settings" backHref={homeHref(model)} backLabel="Go to home" />
      );
    }
    throw error;
  }

  return (
    <>
      <PageHeader
        title="Reminders"
        description={`When ${client.name}'s owners and approvers are reminded by email.`}
      />
      <RemindersForm
        clientId={clientId}
        version={view.version}
        reminders={view.settings.reminders}
      />
    </>
  );
}
