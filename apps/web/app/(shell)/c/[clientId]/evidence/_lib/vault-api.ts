// The evidence vault's calls to the API and its URL. Plain functions of an API client, so the Server Actions stay thin
// and the tests can run these against the in-process mock. The filters live in the URL under the API's own names.
import { EvidenceVaultQuery, MAX_PAGE_LIMIT, type EvidenceView } from '@canopy/contracts';
import type { FilterOption } from '@canopy/ui';

import type { ApiClient, CallRequest } from '../../../../../../lib/api/client';

export type VaultPage = { rows: EvidenceView[]; nextCursor: string | null; total?: number };

type VaultQuery = NonNullable<CallRequest<'evidenceVault'>['query']>;

/** The vault's filters, in the URL and in the API query alike. */
export const VAULT_KEYS = ['q', 'scanStatus', 'unitId', 'uploadedFrom', 'uploadedTo'] as const;

/**
 * The API query for a page URL: the vault's filters only, each kept when the contract accepts it, so a hand-edited or
 * stale link shows the vault with the filters that still make sense rather than an error.
 */
export function vaultQuery(search: URLSearchParams): string {
  const kept = new URLSearchParams();
  for (const key of VAULT_KEYS) {
    const value = search.get(key);
    if (value === null || value === '') continue;
    if (EvidenceVaultQuery.safeParse({ [key]: value }).success) kept.set(key, value);
  }
  // Each date is valid alone; a backwards range drops its end.
  if (!EvidenceVaultQuery.safeParse(Object.fromEntries(kept)).success) kept.delete('uploadedTo');
  return kept.toString();
}

/** One page of the vault, newest first. The first page also asks for the count. */
export async function loadVault(
  api: Pick<ApiClient, 'call'>,
  clientId: string,
  query: string,
  cursor?: string,
): Promise<VaultPage> {
  const { data } = await api.call('evidenceVault', {
    params: { clientId },
    query: {
      ...(Object.fromEntries(new URLSearchParams(query)) as VaultQuery),
      limit: String(MAX_PAGE_LIMIT),
      ...(cursor ? { cursor } : { count: 'true' }),
    },
  });
  return {
    rows: data.items,
    nextCursor: data.nextCursor,
    ...(data.total === undefined ? {} : { total: data.total }),
  };
}

export type VaultLookups = {
  /** Who uploaded each file, from the client's people (first page). */
  names: Record<string, string>;
  units: FilterOption[];
};

/** Names and the Unit filter's choices. The vault works without them, so a list that fails is just empty. */
export async function loadLookups(
  api: Pick<ApiClient, 'call'>,
  clientId: string,
): Promise<VaultLookups> {
  const params = { clientId };
  const query = { limit: String(MAX_PAGE_LIMIT) };
  const [people, units] = await Promise.all([
    api.call('listClientPeople', { params, query }).then(
      (r) => r.data.items,
      () => [],
    ),
    api.call('listUnits', { params, query }).then(
      (r) => r.data.items,
      () => [],
    ),
  ]);
  return {
    names: Object.fromEntries(people.map((p) => [p.id, p.displayName])),
    units: units
      .map((u) => ({ value: u.id, label: u.name }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

/** The instance a file belongs to, as the register's drawer shows it. */
export function instanceHref(clientId: string, instanceId: string): string {
  return `/c/${encodeURIComponent(clientId)}/register/${encodeURIComponent(instanceId)}`;
}
