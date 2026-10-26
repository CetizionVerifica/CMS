// Everything the in-process mock (mock.ts) doesn't answer goes to M0's mock server (@canopy/contracts/mock), so the
// pages M12 and M13 build get real contract responses in dev and e2e. M0's server runs in-process through Fastify's
// `inject`; nothing listens on a port.
//
// The shell's demo world (its clients, accounts and sign-in) stays in mock.ts, which the shell's and M13's tests rely
// on. M0's store holds the synthetic firm B fixture instead, so ids are translated at this boundary: our client ids
// become firm B's in the request and come back as ours in the response, with the client names to match, and the
// signed-in demo account acts as a firm B person with the same kind of access (`x-mock-person`), with its own account's
// add-ons (`x-mock-features`), so `/me` and every delegated route agree on them. Ids that exist only
// in M0's data (units, instances, people) pass through unchanged, so a page can follow them in later requests.
// From the fixtures entry, not `/mock`: a value import from `/mock` would load Fastify on every server render.
import { FIRM_B_AS_OF } from '@canopy/contracts/fixtures';

/** Our client → firm B's client, both ways. Sunrise Foods has no counterpart, so its pages answer NOT_FOUND. */
export const CLIENT_MAP: readonly {
  ours: string;
  theirs: string;
  ourName: string;
  theirName: string;
}[] = [
  {
    ours: '00000000-0000-5000-8000-000000000101',
    theirs: 'db063d65-238b-521a-9925-3bd7e9ca742a',
    ourName: 'Demo Metals',
    theirName: 'Northwind Foods Group',
  },
  {
    ours: '00000000-0000-5000-8000-000000000102',
    theirs: '6ab27146-a85a-56e6-b6e0-201c56a943eb',
    ourName: 'Northwind Textiles',
    theirName: 'Harbour Retail Group',
  },
];

/**
 * Demo account → the firm B person it acts as. Firm users act as firm B's firm admin, who sees both mapped clients
 * (firm B's consultants each see only one); client users act as a person with the same role at Northwind Foods.
 */
export const PERSON_MAP: Readonly<Record<string, string>> = {
  'consultant@demo.test': '7d2ed867-adfc-5e58-b716-9e5a9e1f9d1c',
  'admin@demo.test': '7d2ed867-adfc-5e58-b716-9e5a9e1f9d1c',
  'twofirms@demo.test': '7d2ed867-adfc-5e58-b716-9e5a9e1f9d1c',
  'company@demo.test': '7d2ed867-adfc-5e58-b716-9e5a9e1f9d1c',
  'owner@demo.test': '487294a3-c71b-5708-9153-f15e95bc7c48',
  'approver@demo.test': 'e06422d9-6bc6-5d81-a932-840a6d5228df',
  // Firm B's viewer whose access runs to March 2027, so it is live at FIRM_B_AS_OF.
  'viewer@demo.test': '6d38d91c-de98-5d00-9461-a684931f2e31',
};

type MockServer = Awaited<ReturnType<typeof startServer>>;
// One server per process, on globalThis: Next.js loads this module once for page renders and again for Server
// Actions, and a module-level variable would give each its own store (an approve in one, a stale row in the other).
const shared = globalThis as typeof globalThis & { __ppMockServer?: Promise<MockServer> };

async function startServer() {
  // Loaded on first use: Fastify stays out of every path that never reaches the mock.
  const { createMockServer, MockStore } = await import('@canopy/contracts/mock');
  const app = createMockServer({
    store: new MockStore(['firm-b.synthetic']),
    // Firm B's "today", so derived statuses and scores agree with its data; mock.ts uses it as the as-of date too.
    today: FIRM_B_AS_OF,
  });
  await app.ready();
  return app;
}

function replaceAll(text: string, pairs: readonly [string, string][]): string {
  return pairs.reduce((acc, [from, to]) => acc.split(from).join(to), text);
}

const toTheirs = CLIENT_MAP.map((c) => [c.ours, c.theirs] as [string, string]);
const toOurs = CLIENT_MAP.flatMap(
  (c) =>
    [
      [c.theirs, c.ours],
      [c.theirName, c.ourName],
    ] as [string, string][],
);

/**
 * Answers one request from M0's mock server, as `email` (a demo account) whose account has `features`, translating
 * ids both ways. Firm B has the ISO add-on, so without the header every demo user would get ISO data; with it, the
 * company admin's account (no add-ons) gets 403 FEATURE_NOT_ENABLED on `/iso` routes and no STANDARD instances.
 */
export async function delegateToM0(
  email: string,
  features: readonly string[],
  method: string,
  url: URL,
  body: string | undefined,
): Promise<Response> {
  const person = PERSON_MAP[email];
  const app = await (shared.__ppMockServer ??= startServer());
  const res = await app.inject({
    method: method as 'GET',
    url: replaceAll(`${url.pathname}${url.search}`, toTheirs),
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(person ? { 'x-mock-person': person } : {}),
      // Always sent: empty means no add-ons, where leaving it out would mean firm B's.
      'x-mock-features': features.join(','),
    },
    ...(body === undefined ? {} : { payload: replaceAll(body, toTheirs) }),
  });
  const headers = new Headers({ 'x-request-id': 'mock' });
  const type = res.headers['content-type'];
  if (typeof type === 'string') headers.set('content-type', type);
  // 204 and 304 carry no body.
  const text =
    res.statusCode === 204 || res.statusCode === 304 ? null : replaceAll(res.body, toOurs);
  return new Response(text, { status: res.statusCode, headers });
}
