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
  const [
    overview,
    systems,
    standards,
    clauses,
    units,
    people,
    docs,
    certs,
    audits,
    defs,
    risks,
    objectives,
    actions,
    ncs,
    programmes,
    internalAudits,
  ] = await Promise.all([
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
    a
      .call('listIsoRisks', { ...p, query: { ...limit, includeArchived: 'true' } })
      .then((r) => r.data.items),
    a.call('listIsoObjectives', { ...p, query: limit }).then((r) => r.data.items),
    a.call('listIsoActions', { ...p, query: limit }).then((r) => r.data.items),
    a.call('listIsoNonconformities', { ...p, query: limit }).then((r) => r.data.items),
    a.call('listIsoAuditProgrammes', { ...p, query: limit }).then((r) => r.data.items),
    a.call('listIsoInternalAudits', { ...p, query: limit }).then((r) => r.data.items),
  ]);
  const system = systems[0]!;
  // Every item's controls and every objective's readings, keyed by their item or objective.
  const [controls, readings, auditChecklists, auditFindings] = await Promise.all([
    keyed(risks, (r) => riskControls(a, r.id)),
    keyed(objectives, (o) => objectiveReadings(a, o.id)),
    keyed(internalAudits, (x) => auditChecklist(a, x.id)),
    keyed(internalAudits, (x) => internalFindings(a, x.id)),
  ]);
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
    risks,
    controls,
    objectives,
    readings,
    actions,
    ncs,
    programmes,
    internalAudits,
    auditChecklists,
    auditFindings,
  };
}

async function keyed<T extends { id: string }, V>(
  items: readonly T[],
  read: (item: T) => Promise<V>,
): Promise<Record<string, V>> {
  return Object.fromEntries(await Promise.all(items.map(async (i) => [i.id, await read(i)])));
}

const riskControls = async (a: ApiClient, id: string) =>
  (await a.call('listIsoRiskControls', { params: { clientId: CLIENT, id } })).data.items;
const objectiveReadings = async (a: ApiClient, id: string) =>
  (await a.call('listIsoReadings', { params: { clientId: CLIENT, id } })).data.items;

export type IsoData = Awaited<ReturnType<typeof isoData>>;
const auditChecklist = async (a: ApiClient, id: string) =>
  (await a.call('listIsoAuditChecklist', { params: { clientId: CLIENT, id } })).data.items;
const internalFindings = async (a: ApiClient, id: string) =>
  (await a.call('listIsoInternalFindings', { params: { clientId: CLIENT, id } })).data.items;
