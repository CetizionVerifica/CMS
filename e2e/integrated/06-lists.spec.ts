import { ENDPOINTS } from '@canopy/contracts';
import { expect, test } from '@playwright/test';

import { apiAs } from './api.js';
import { seeded } from './helpers.js';

// Every firm-wide and client-wide list answers at the largest page size the contract allows (api-conventions.md §3),
// which is what the web app asks for when it loads a whole list (for example every Act for the library filters).
type Endpoint = {
  method: string;
  path: string;
  query?: { shape?: Record<string, unknown> } | null;
};

// F13 (docs/security/review.md, fixed in #154): M6's lists used to answer 500 at limit=200.
test('every client and firm list answers a full page of 200', async () => {
  const { kestrel } = seeded().clients;
  // The consultant reads the firm's and the client's lists; the approver their own queues under /me.
  const consultant = await apiAs('consultant');
  const approver = await apiAs('approver');
  const failures: string[] = [];
  for (const [name, e] of Object.entries(ENDPOINTS as Record<string, Endpoint>)) {
    const shape = e.query?.shape ?? {};
    if (e.method !== 'GET' || !('limit' in shape)) continue;
    // Lists under one record (an import's rows, a person's memberships) are paged the same way; these are the lists
    // the screens load whole.
    if (e.path.replace('{clientId}', '').includes('{')) continue;
    const path = `${e.path.replace('{clientId}', kestrel)}?limit=200${'fy' in shape ? '&fy=2022-23' : ''}`;
    const res = await (path.startsWith('/me/') ? approver : consultant).get(path);
    if (res.status !== 200) failures.push(`${name} GET ${path} -> ${res.status}`);
  }
  await consultant.dispose();
  await approver.dispose();
  expect(failures).toEqual([]);
});
