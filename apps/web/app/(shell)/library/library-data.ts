// Server-side reads for the library pages.
import 'server-only';

import type { Act } from '@canopy/contracts';

import type { ApiClient } from '../../../lib/api/client';

/** Most a firm library is expected to hold; past this the Act filter and names fall back to "Unknown Act". */
const MAX_ACT_PAGES = 5;

/** Every Act the user can see (for names and the Act filter), following the cursor up to 1,000 Acts. */
export async function loadAllActs(api: ApiClient): Promise<Act[]> {
  const acts: Act[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_ACT_PAGES; page++) {
    const { data } = await api.call('listActs', {
      query: { limit: '200', ...(cursor ? { cursor } : {}) },
    });
    acts.push(...data.items);
    if (!data.nextCursor) break;
    cursor = data.nextCursor;
  }
  return acts;
}

/** Next's searchParams as URLSearchParams (first value of a repeated key). */
export function toSearchParams(
  raw: Record<string, string | string[] | undefined>,
): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') search.set(key, value);
    else if (Array.isArray(value) && value[0] !== undefined) search.set(key, value[0]);
  }
  return search;
}
