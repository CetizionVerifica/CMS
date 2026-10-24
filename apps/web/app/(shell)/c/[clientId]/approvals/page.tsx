import type { Role } from '@canopy/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { isApiError } from '../../../../../lib/api/client';
import { getMe, serverApi } from '../../../../../lib/api/server';
import { NoPermission, PageHeader } from '../../../../../lib/patterns';
import { homeHref } from '../../../../../lib/shell/model';
import { loadShell } from '../../../../../lib/shell/server';
import { ApprovalsView } from './_components/ApprovalsView';
import { loadQueue, type QueueScope } from './_lib/approvals-api';

type Props = { params: Promise<{ clientId: string }> };

/** "Approvals · Demo Metals", as every client page is titled (the shell adds the product name). */
export async function generateMetadata({ params }: Pick<Props, 'params'>): Promise<Metadata> {
  const { clientId } = await params;
  const client = (await loadShell()).clients.find((c) => c.id === clientId);
  return { title: ['Approvals', client?.name].filter(Boolean).join(' · ') };
}

/** Roles that may reopen and remove any evidence in a client (the instance and evidence endpoints' FA CO CA). */
const MANAGERS: readonly Role[] = ['FIRM_ADMIN', 'CONSULTANT', 'CLIENT_ADMIN'];

// The approvals inbox (apps/web/CLAUDE.md "Approvals"): what waits for the person's approval in this client, oldest due
// date first, with J/K/A/S on the list and the instance drawer over it. GET /me/approvals counts across every client,
// so the header says how many wait elsewhere. `/approvals/<id>` renders this same page with that drawer open.
export default async function ApprovalsPage({ params }: Props) {
  const { clientId } = await params;
  const model = await loadShell();
  const me = await getMe();
  const client = model.clients.find((c) => c.id === clientId);
  // The client layout already checked the session and 404s an unknown client; this keeps the types honest.
  if (!client || !me) notFound();
  const roles = model.roles.byClient[clientId] ?? [];
  const noPermission = (
    <NoPermission what="approvals" backHref={homeHref(model)} backLabel="Go to home" />
  );
  // The same roles as the sidebar's Approvals item and GET /me/approvals.
  if (!roles.includes('CLIENT_ADMIN') && !roles.includes('APPROVER')) return noPermission;
  const scope: QueueScope = roles.includes('CLIENT_ADMIN') ? 'client' : 'mine';

  let page;
  try {
    page = await loadQueue(await serverApi(), clientId, scope);
  } catch (error) {
    if (isApiError(error, 'FORBIDDEN', 'ACCESS_EXPIRED')) return noPermission;
    // The API answers 404 for a client outside the person's scope (api-conventions.md §5).
    if (isApiError(error, 'NOT_FOUND')) notFound();
    throw error;
  }

  return (
    <>
      <PageHeader
        title="Approvals"
        description={`Items in ${client.name} waiting for ${scope === 'mine' ? 'your ' : ''}approval, oldest due date first.`}
      />
      <ApprovalsView
        clientId={clientId}
        personId={me.person.id}
        scope={scope}
        page={page}
        waitingEverywhere={model.approvalsWaiting}
        canManage={roles.some((r) => MANAGERS.includes(r))}
        timeZone={client.timeZone}
      />
    </>
  );
}
