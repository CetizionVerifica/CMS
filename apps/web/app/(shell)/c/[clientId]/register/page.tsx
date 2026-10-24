import type { Role } from '@canopy/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { isApiError } from '../../../../../lib/api/client';
import { getMe, serverApi } from '../../../../../lib/api/server';
import { NoPermission, PageHeader } from '../../../../../lib/patterns';
import { homeHref } from '../../../../../lib/shell/model';
import { loadShell } from '../../../../../lib/shell/server';
import { RegisterView } from './_components/RegisterView';
import { apiQueryFromParams, registerPeriod } from './_lib/query';
import { loadFacets, loadPage } from './_lib/register-api';

type Props = {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** "Register · Demo Metals", as every client page is titled (the shell adds the product name). */
export async function generateMetadata({ params }: Pick<Props, 'params'>): Promise<Metadata> {
  const { clientId } = await params;
  const client = (await loadShell()).clients.find((c) => c.id === clientId);
  return { title: ['Register', client?.name].filter(Boolean).join(' · ') };
}

/** Roles that may approve in a client (bulkApprove: CLIENT_ADMIN, APPROVER for their own items). */
const APPROVERS: readonly Role[] = ['CLIENT_ADMIN', 'APPROVER'];
/** Roles that may reopen, reassign and remove any evidence in a client (the instance and evidence endpoints' FA CO CA). */
const MANAGERS: readonly Role[] = ['FIRM_ADMIN', 'CONSULTANT', 'CLIENT_ADMIN'];
/** Roles that may export (createExport): everyone but an OWNER. */
const EXPORTERS: readonly Role[] = [
  'FIRM_ADMIN',
  'CONSULTANT',
  'CLIENT_ADMIN',
  'APPROVER',
  'VIEWER',
];

/** Next's search params as URLSearchParams; a repeated key keeps its first value, as `URLSearchParams.get` would. */
function toSearch(raw: Record<string, string | string[] | undefined>): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) search.set(key, first);
  }
  return search;
}

// The register (apps/web/CLAUDE.md "Register"): every instance in the selected period, filtered by the URL. The
// first page renders on the server; the grid loads more on request. `/register/<id>` renders this same page, and the
// view opens that instance's drawer over it (./[instanceId]/page.tsx).
export default async function RegisterPage({ params, searchParams }: Props) {
  const { clientId } = await params;
  const search = toSearch(await searchParams);
  const model = await loadShell();
  const me = await getMe();
  const client = model.clients.find((c) => c.id === clientId);
  // The client layout already checked the session and 404s an unknown client; this keeps the types honest.
  if (!client || !me) notFound();
  const roles = model.roles.byClient[clientId] ?? [];

  const query = apiQueryFromParams(search, registerPeriod(search, client)).toString();
  const api = await serverApi();
  let page;
  try {
    page = await loadPage(api, clientId, query);
  } catch (error) {
    if (isApiError(error, 'FORBIDDEN', 'ACCESS_EXPIRED')) {
      return (
        <NoPermission what="this register" backHref={homeHref(model)} backLabel="Go to home" />
      );
    }
    // The API answers 404 for a client outside the person's scope (api-conventions.md §5).
    if (isApiError(error, 'NOT_FOUND')) notFound();
    throw error;
  }
  const facets = await loadFacets(api, clientId);

  return (
    <>
      <PageHeader title="Register" description={`Every compliance instance for ${client.name}.`} />
      <RegisterView
        clientId={clientId}
        personId={me.person.id}
        query={query}
        page={page}
        facets={facets}
        canApprove={roles.some((r) => APPROVERS.includes(r))}
        canExport={roles.some((r) => EXPORTERS.includes(r))}
        canManage={roles.some((r) => MANAGERS.includes(r))}
        timeZone={client.timeZone}
      />
    </>
  );
}
