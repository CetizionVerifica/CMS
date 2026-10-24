import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { isApiError } from '../../../../../lib/api/client';
import { serverApi } from '../../../../../lib/api/server';
import { NoPermission, PageHeader } from '../../../../../lib/patterns';
import { homeHref } from '../../../../../lib/shell/model';
import { loadShell } from '../../../../../lib/shell/server';
import { EvidenceVault } from './_components/EvidenceVault';
import { loadLookups, loadVault, vaultQuery } from './_lib/vault-api';

type Props = {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** "Evidence · Demo Metals", as every client page is titled (the shell adds the product name). */
export async function generateMetadata({ params }: Pick<Props, 'params'>): Promise<Metadata> {
  const { clientId } = await params;
  const client = (await loadShell()).clients.find((c) => c.id === clientId);
  return { title: ['Evidence', client?.name].filter(Boolean).join(' · ') };
}

/** Next's search params as URLSearchParams; a repeated key keeps its first value. */
function toSearch(raw: Record<string, string | string[] | undefined>): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) search.set(key, first);
  }
  return search;
}

// The evidence vault (MODULES.md M12): every file attached to the client's instances that the person may see (an
// APPROVER or OWNER only their units'), newest first, filtered by the URL. Each file links to its instance's drawer
// and opens through a signed URL fetched on the click.
export default async function EvidencePage({ params, searchParams }: Props) {
  const { clientId } = await params;
  const model = await loadShell();
  const client = model.clients.find((c) => c.id === clientId);
  // The client layout already checked the session and 404s an unknown client; this keeps the types honest.
  if (!client) notFound();

  const query = vaultQuery(toSearch(await searchParams));
  const api = await serverApi();
  let page;
  try {
    page = await loadVault(api, clientId, query);
  } catch (error) {
    if (isApiError(error, 'FORBIDDEN', 'ACCESS_EXPIRED')) {
      return (
        <NoPermission what="this evidence" backHref={homeHref(model)} backLabel="Go to home" />
      );
    }
    // The API answers 404 for a client outside the person's scope (api-conventions.md §5).
    if (isApiError(error, 'NOT_FOUND')) notFound();
    throw error;
  }
  const lookups = await loadLookups(api, clientId);

  return (
    <>
      <PageHeader
        title="Evidence"
        description={`Every evidence file attached to ${client.name}’s instances, newest first.`}
      />
      <EvidenceVault
        clientId={clientId}
        query={query}
        page={page}
        lookups={lookups}
        timeZone={client.timeZone}
      />
    </>
  );
}
