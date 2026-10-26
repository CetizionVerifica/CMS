// Real ISO records for unit tests, read through the web app's in-process mock API (M0's mock behind lib/api/mock.ts),
// so the views are tested against the data the API sends rather than hand-made copies of it.
import { createApiClient, type ApiClient } from '../../../../../../lib/api/client';
import {
  MOCK_CLIENTS,
  MOCK_MFA_CODE,
  MOCK_PASSWORD,
  mockFetch,
} from '../../../../../../lib/api/mock';

export const CLIENT = MOCK_CLIENTS.demoMetals;

const FIRM_USERS = ['consultant@demo.test', 'admin@demo.test', 'company@demo.test'];

/** An API client signed in as one of the demo users. */
export async function signedIn(email: string): Promise<ApiClient> {
  const api = (cookie?: string) =>
    createApiClient({ baseUrl: 'http://api.test', fetch: mockFetch, cookie });
  const { setCookies } = await api().login({ email, password: MOCK_PASSWORD });
  let cookie = setCookies[0]!.split(';')[0]!;
  if (FIRM_USERS.includes(email)) {
    cookie = (await api(cookie).verifyMfa(MOCK_MFA_CODE)).setCookies[0]!.split(';')[0]!;
  }
  return api(cookie);
}

/**
 * The demo client's ISO records as the consultant reads them. Component tests (jsdom, where the mock can't read its
 * fixture files) load the same records from `iso-data.json`; `iso-data.test.ts` keeps that copy equal to this.
 */
export async function isoData(api?: ApiClient) {
  const a = api ?? (await signedIn('consultant@demo.test'));
  const p = { params: { clientId: CLIENT } };
  const limit = { limit: '200' };
  const [overview, systems, standards, clauses, units, people, docs, certs, audits, defs] =
    await Promise.all([
      a.call('getIsoOverview', p).then((r) => r.data),
      a.call('listIsoSystems', { ...p, query: limit }).then((r) => r.data.items),
      a.call('listIsoStandards', p).then((r) => r.data.items),
      a.call('listIsoClauses', p).then((r) => r.data.items),
      a.call('listUnits', { ...p, query: limit }).then((r) => r.data.items),
      a.call('listClientPeople', { ...p, query: limit }).then((r) => r.data.items),
      a
        .call('listIsoDocuments', { ...p, query: { ...limit, status: 'ACTIVE,OBSOLETE' } })
        .then((r) => r.data.items),
      a.call('listIsoCertifications', { ...p, query: limit }).then((r) => r.data.items),
      a.call('listIsoExternalAudits', { ...p, query: limit }).then((r) => r.data.items),
      a.call('listIsoReviewDefs', p).then((r) => r.data),
    ]);
  const system = systems[0]!;
  const [checklist, contextItems] = await Promise.all([
    a
      .call('listIsoChecklist', { params: { clientId: CLIENT, id: system.id } })
      .then((r) => r.data.items),
    a
      .call('listIsoContextItems', { params: { clientId: CLIENT, id: system.id } })
      .then((r) => r.data.items),
  ]);
  const personOptions = people
    .map((x) => ({ id: x.id, name: x.displayName }))
    .sort((x, y) => x.name.localeCompare(y.name));
  return {
    overview,
    systems,
    system,
    standards,
    clauses,
    units,
    people: personOptions,
    docs,
    certs,
    audits,
    defs,
    checklist,
    contextItems,
  };
}

export type IsoData = Awaited<ReturnType<typeof isoData>>;
