// Reads the ISO pages share: the account's catalogue, the client's systems, people and units. Every call goes through
// the typed API client, so each answer is checked against its contracts schema at the boundary.
import 'server-only';

import type { IsoStandard, Person, Unit } from '@canopy/contracts';

import type { ApiClient } from '../../../../../../lib/api/client';
import type { PersonOption } from './people';

const PAGE = '200';
const MAX_PAGES = 10;

/** Every page of a paged list, up to 2,000 items. */
export async function allPages<T>(
  read: (query: { limit: string; cursor?: string }) => Promise<{
    items: T[];
    nextCursor: string | null;
  }>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await read({ limit: PAGE, ...(cursor ? { cursor } : {}) });
    items.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return items;
}

export async function standards(api: ApiClient, clientId: string): Promise<IsoStandard[]> {
  return (await api.call('listIsoStandards', { params: { clientId } })).data.items;
}

export async function systems(api: ApiClient, clientId: string) {
  return allPages(
    async (query) => (await api.call('listIsoSystems', { params: { clientId }, query })).data,
  );
}

export async function clauses(api: ApiClient, clientId: string) {
  return (await api.call('listIsoClauses', { params: { clientId } })).data.items;
}

export async function units(api: ApiClient, clientId: string): Promise<Unit[]> {
  return allPages(
    async (query) => (await api.call('listUnits', { params: { clientId }, query })).data,
  );
}

/**
 * The client's people, for names and for pickers. A role that may not list people (or a failed list) names no one
 * rather than failing the page; ids then read as "Someone".
 */
export async function people(api: ApiClient, clientId: string): Promise<PersonOption[]> {
  const list = await allPages(
    async (query) => (await api.call('listClientPeople', { params: { clientId }, query })).data,
  ).catch((): Person[] => []);
  return list
    .filter((p) => p.archivedAt === null)
    .map((p) => ({ id: p.id, name: p.displayName }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
