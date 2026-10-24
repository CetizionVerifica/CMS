import type { Department } from '@canopy/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { isApiError } from '../../../../../../lib/api/client';
import { redirectIfSignedOut } from '../../overview/signed-out';
import { serverApi } from '../../../../../../lib/api/server';
import { NoPermission, PageHeader } from '../../../../../../lib/patterns';
import { routeByPath, visibleTo } from '../../../../../../lib/routes';
import { homeHref } from '../../../../../../lib/shell/model';
import { loadShell } from '../../../../../../lib/shell/server';
import { departmentRows } from '../setup-model';
import { DepartmentsView } from './DepartmentsView';

type Props = { params: Promise<{ clientId: string }> };

const MAX_PAGES = 10;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { clientId } = await params;
  const client = (await loadShell()).clients.find((c) => c.id === clientId);
  return { title: ['Departments', client?.name].filter(Boolean).join(' · ') };
}

// Setup: the client's departments (MODULES.md M13 "setup screens"). Up to 2,000 are read, since a client
// has tens of departments, not thousands, and merging needs all of them on screen.
export default async function DepartmentsPage({ params }: Props) {
  const { clientId } = await params;
  const model = await loadShell();
  const client = model.clients.find((c) => c.id === clientId);
  if (!client) notFound();
  // Owners and approvers can read some of this through the API but change none of it, so the page is not theirs.
  if (!visibleTo(routeByPath('setup/departments'), model.roles.byClient[clientId] ?? [])) {
    return (
      <NoPermission
        what="departments"
        backHref={`/c/${clientId}/overview`}
        backLabel="Go to overview"
      />
    );
  }
  const api = await serverApi();

  const departments: Department[] = [];
  try {
    let cursor: string | null = null;
    // At most MAX_PAGES pages, so a misbehaving cursor cannot keep the page loading.
    for (let i = 0; i < MAX_PAGES; i++) {
      const page: { items: Department[]; nextCursor: string | null } = (
        await api.call('listDepartments', {
          params: { clientId },
          query: { limit: '200', ...(cursor ? { cursor } : {}) },
        })
      ).data;
      departments.push(...page.items);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
  } catch (error) {
    await redirectIfSignedOut(error);
    if (isApiError(error, 'FORBIDDEN', 'ACCESS_EXPIRED')) {
      return <NoPermission what="departments" backHref={homeHref(model)} backLabel="Go to home" />;
    }
    throw error;
  }

  return (
    <>
      <PageHeader
        title="Departments"
        description={`The departments ${client.name}'s obligations are assigned to.`}
      />
      <DepartmentsView clientId={clientId} rows={departmentRows(departments)} />
    </>
  );
}
