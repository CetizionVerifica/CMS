import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENDPOINTS, type Endpoint } from '../src/api/endpoints.js';
import { ApiErrorResponse } from '../src/api/error-details.js';
import { SESSION_COOKIE } from '../src/api/openapi.js';
import { DEFAULT_CLIENT_SETTINGS } from '../src/defaults.js';
import { FIRM_B_AS_OF, fixtureId, loadExpected } from '../src/fixtures/index.js';
import { createMockServer, HANDLERS, MOCK_BASE_PATH } from '../src/mock/index.js';
import { SAMPLE_COLUMNS, SAMPLE_SHEET } from '../src/mock/handlers/imports.js';

type Id = keyof typeof ENDPOINTS;
type App = ReturnType<typeof createMockServer>;

const TODAY = FIRM_B_AS_OF;
const b = (key: string) => fixtureId(`firm-b:${key}`);
const PERSON = {
  meera: b('person:meera'), // FIRM_ADMIN
  arjun: b('person:arjun'), // CONSULTANT for Northwind
  leela: b('person:leela'), // CONSULTANT for Harbour only
  kabir: b('person:kabir'), // CLIENT_ADMIN
  nisha: b('person:nisha'), // APPROVER, Pune
  rohan: b('person:rohan'), // OWNER, Pune
  sameer: b('person:sameer'), // OWNER, all Northwind units
  tara: b('person:tara'), // VIEWER, expired
  vikram: b('person:vikram'), // VIEWER
  gita: b('person:gita'), // DISABLED
  farhan: b('person:farhan'), // UNCLAIMED
};
const NORTHWIND = b('client:northwind');
const HARBOUR = b('client:harbour');
const PUNE = b('unit:pune');
const instanceId = (code: string, unit: string, periodStart: string) =>
  b(`instance:${code}:${unit}:${periodStart}`);
const MONTHLY_REGISTER = (periodStart: string) =>
  instanceId('SLC-EHS-002', 'Pune Plant', periodStart);
const TDS_SUBMITTED = instanceId('SLC-TAX-001', 'Pune Plant', '2024-10-01');

interface Call {
  as?: string | null;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
}

const called = new Set<Id>();

async function call(
  app: App,
  id: Id,
  { as = PERSON.meera, params = {}, query, body, headers = {} }: Call = {},
) {
  const ep: Endpoint = ENDPOINTS[id];
  called.add(id);
  const path = ep.path.replace(/\{(\w+)\}/g, (_, name: string) =>
    encodeURIComponent(params[name]!),
  );
  const search = query === undefined ? '' : `?${new URLSearchParams(query).toString()}`;
  const response = await app.inject({
    method: ep.method,
    url: `${MOCK_BASE_PATH}${path}${search}`,
    headers: {
      ...(as === null ? {} : { 'x-mock-person': as }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  const json = response.body === '' ? null : (JSON.parse(response.body) as unknown);
  return { status: response.statusCode, json, headers: response.headers };
}

/** Calls an endpoint and checks the status and response schema the endpoint table promises. */
async function ok<T = Record<string, unknown>>(app: App, id: Id, request?: Call): Promise<T> {
  const result = await call(app, id, request);
  if (result.status !== ENDPOINTS[id].status) {
    throw new Error(`${id}: ${result.status} ${JSON.stringify(result.json)}`);
  }
  expect(ENDPOINTS[id].response.safeParse(result.json).success, id).toBe(true);
  return result.json as T;
}

async function fails(app: App, id: Id, request: Call, code: string, status: number) {
  const result = await call(app, id, request);
  expect(result.status, `${id} ${JSON.stringify(result.json)}`).toBe(status);
  expect(ApiErrorResponse.parse(result.json).error.code).toBe(code);
  return result.json as { error: { details?: Record<string, unknown> } };
}

const firstToken = (app: App, kind: string, to?: string) =>
  [...app.store.outbox].reverse().find((m) => m.kind === kind && (to === undefined || m.to === to))!
    .token;

describe('mock server', () => {
  let app: App;
  beforeAll(async () => {
    app = createMockServer({ today: TODAY });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    // Every endpoint in the table has a handler and was called with a valid request ("serves every endpoint").
    expect(Object.keys(HANDLERS).sort()).toEqual(Object.keys(ENDPOINTS).sort());
    expect([...called].sort()).toEqual(Object.keys(ENDPOINTS).sort());
  });

  it('signs in with a password, a magic link or an invite, and checks MFA and CSRF', async () => {
    const login = await call(app, 'login', {
      as: null,
      body: { email: 'kabir.shah@northwind.example', password: 'correct horse battery' },
    });
    expect(login.status).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    const me = login.json as {
      csrfToken: string;
      clients: { id: string }[];
      mfa: { required: boolean };
      session: { expiresAt: string };
    };
    expect(me.clients.map((c) => c.id)).toEqual([NORTHWIND]);
    expect(me.mfa.required).toBe(false);
    expect(me.session.expiresAt).toBe('2024-11-15T18:30:00Z');

    await ok(app, 'getMe', { as: null, headers: { cookie } });
    // Each client carries what the period picker needs, so the web app does no FY maths.
    type Summary = {
      id: string;
      fyStartMonth: number;
      timeZone: string;
      unitCount: number;
      period: {
        current: { fy: string; quarter: number };
        availableFys: string[];
        availableUntil: string | null;
      };
    };
    const northwind = (await ok<{ clients: Summary[] }>(app, 'getMe', { as: PERSON.kabir }))
      .clients[0]!;
    expect(northwind).toMatchObject({ fyStartMonth: 4, timeZone: 'Asia/Kolkata' });
    expect(northwind.period.current).toEqual({ fy: '2024-25', quarter: 3 });
    expect(northwind.period.availableFys).toContain('2024-25');
    expect(northwind.period.availableUntil).toMatch(/^\d{4}-\d{2}$/);
    const rohanMe = await ok<{ clients: Summary[] }>(app, 'getMe', { as: PERSON.rohan });
    expect(rohanMe.clients[0]!.unitCount).toBe(1);
    expect(northwind.unitCount).toBeGreaterThan(1);
    const harbour = (
      await ok<{ clients: Summary[] }>(app, 'getMe', { as: PERSON.meera })
    ).clients.find((c) => c.id === HARBOUR)!;
    expect(harbour.fyStartMonth).toBe(1);
    expect(harbour.period.current.quarter).toBe(4);
    await fails(app, 'logout', { as: null, headers: { cookie } }, 'FORBIDDEN', 403);
    await ok(app, 'logout', { as: null, headers: { cookie, 'x-csrf-token': me.csrfToken } });
    await fails(app, 'getMe', { as: null, headers: { cookie } }, 'UNAUTHENTICATED', 401);

    await fails(
      app,
      'login',
      { as: null, body: { email: 'nobody@northwind.example', password: 'correct horse battery' } },
      'UNAUTHENTICATED',
      401,
    );
    await fails(
      app,
      'login',
      {
        as: null,
        body: { email: 'gita.das@northwind.example', password: 'correct horse battery' },
      },
      'UNAUTHENTICATED',
      401,
    );

    await ok(app, 'requestMagicLink', {
      as: null,
      body: { email: 'nisha.patil@northwind.example' },
    });
    await ok(app, 'requestMagicLink', { as: null, body: { email: 'nobody@northwind.example' } });
    const token = firstToken(app, 'MAGIC_LINK');
    await ok(app, 'verifyMagicLink', { as: null, body: { token } });
    await fails(app, 'verifyMagicLink', { as: null, body: { token } }, 'UNAUTHENTICATED', 401);

    // A firm role must pass MFA before anything else.
    const admin = await call(app, 'login', {
      as: null,
      body: { email: 'meera.kulkarni@second-ledger.example', password: 'correct horse battery' },
    });
    const adminCookie = String(admin.headers['set-cookie']).split(';')[0]!;
    const csrf = (admin.json as { csrfToken: string }).csrfToken;
    await fails(
      app,
      'listClients',
      { as: null, headers: { cookie: adminCookie } },
      'MFA_REQUIRED',
      401,
    );
    await ok(app, 'enrollMfa', {
      as: null,
      headers: { cookie: adminCookie, 'x-csrf-token': csrf },
    });
    const verified = await ok<{ mfa: { satisfied: boolean } }>(app, 'verifyMfa', {
      as: null,
      headers: { cookie: adminCookie, 'x-csrf-token': csrf },
      body: { code: '123456' },
    });
    expect(verified.mfa.satisfied).toBe(true);
    await ok(app, 'listClients', { as: null, headers: { cookie: adminCookie } });
  });

  it('asks which firm when an email signs in to more than one', async () => {
    const shared = createMockServer({ today: TODAY });
    await shared.ready();
    const email = 'kabir.shah@northwind.example';
    const [firmA, firmB] = shared.store.firms;
    const other = firmA!.data.people.find((p) => p.status === 'ACTIVE' && p.archivedAt === null)!;
    Object.assign(other, { email });
    const password = 'x';
    const choice = await shared.inject({
      method: 'POST',
      url: `${MOCK_BASE_PATH}/auth/login`,
      payload: { email, password },
    });
    expect(choice.statusCode).toBe(409);
    const body = ApiErrorResponse.parse(choice.json());
    expect(body.error.code).toBe('FIRM_CHOICE_REQUIRED');
    expect(body.error.details).toEqual({
      firms: [
        { id: firmA!.data.firm.id, name: firmA!.data.firm.name },
        { id: firmB!.data.firm.id, name: firmB!.data.firm.name },
      ],
    });
    const chosen = await shared.inject({
      method: 'POST',
      url: `${MOCK_BASE_PATH}/auth/login`,
      payload: { email, password, firmId: firmB!.data.firm.id },
    });
    expect(chosen.statusCode).toBe(200);
    expect((chosen.json() as { person: { id: string } }).person.id).toBe(PERSON.kabir);
    await shared.close();
  });

  it('invites a new person and lets them sign up', async () => {
    const invite = await ok<{ id: string; personId: string }>(app, 'createInvite', {
      body: {
        displayName: 'Asha Kapoor',
        email: 'asha.kapoor@northwind.example',
        role: 'OWNER',
        clientId: NORTHWIND,
        consultantClientIds: null,
        unitIds: [PUNE],
        expiresAt: null,
      },
    });
    const token = firstToken(app, 'INVITE', 'asha.kapoor@northwind.example');
    const preview = await ok<{ clientName: string }>(app, 'getInvite', {
      as: null,
      params: { token },
    });
    expect(preview.clientName).toBe('Northwind Foods Group');
    const me = await ok<{ person: { id: string; status: string } }>(app, 'acceptInvite', {
      as: null,
      params: { token },
      body: { password: 'a long enough password' },
    });
    expect(me.person).toMatchObject({ id: invite.personId, status: 'ACTIVE' });
    await fails(app, 'getInvite', { as: null, params: { token } }, 'NOT_FOUND', 404);

    const second = await ok<{ id: string }>(app, 'createInvite', {
      as: PERSON.kabir,
      body: {
        personId: PERSON.farhan,
        email: 'farhan.ali@northwind.example',
        role: 'OWNER',
        clientId: NORTHWIND,
        consultantClientIds: null,
        unitIds: [PUNE],
        expiresAt: null,
      },
    });
    const revoked = await ok<{ status: string }>(app, 'revokeInvite', {
      as: PERSON.kabir,
      params: { id: second.id },
    });
    expect(revoked.status).toBe('REVOKED');
    await fails(
      app,
      'createInvite',
      {
        as: PERSON.kabir,
        body: {
          displayName: 'New Consultant',
          email: 'nc@second-ledger.example',
          role: 'CONSULTANT',
          clientId: null,
          consultantClientIds: [NORTHWIND],
          unitIds: null,
          expiresAt: null,
        },
      },
      'FORBIDDEN',
      403,
    );
  });

  it('serves clients, entities and people', async () => {
    const page = await ok<{ items: { id: string }[] }>(app, 'listClients', {
      query: { count: 'true' },
    });
    expect(page.items.map((c) => c.id).sort()).toEqual([NORTHWIND, HARBOUR].sort());
    const created = await ok<{ id: string; version: number }>(app, 'createClient', {
      body: { name: 'Bay Traders Group' },
    });
    await fails(app, 'createClient', { body: { name: 'bay traders group' } }, 'DUPLICATE', 409);
    await ok(app, 'getClient', { params: { clientId: created.id } });
    const renamed = await ok<{ version: number }>(app, 'updateClient', {
      params: { clientId: created.id },
      body: { version: 1, name: 'Bay Traders' },
    });
    await fails(
      app,
      'updateClient',
      { params: { clientId: created.id }, body: { version: 1, name: 'Again' } },
      'STALE_VERSION',
      409,
    );
    const archived = await ok<{ version: number; archivedAt: string }>(app, 'archiveClient', {
      params: { clientId: created.id },
      body: { version: renamed.version, reason: 'Duplicate' },
    });
    expect(archived.archivedAt).not.toBeNull();
    await fails(app, 'getClient', { params: { clientId: created.id } }, 'NOT_FOUND', 404);
    await ok(app, 'restoreClient', {
      params: { clientId: created.id },
      body: { version: archived.version },
    });

    const settings = await ok<{ version: number }>(app, 'getClientSettings', {
      as: PERSON.kabir,
      params: { clientId: NORTHWIND },
    });
    await fails(
      app,
      'putClientSettings',
      {
        as: PERSON.kabir,
        params: { clientId: NORTHWIND },
        body: { version: settings.version, settings: DEFAULT_CLIENT_SETTINGS },
      },
      'FORBIDDEN',
      403,
    );
    await ok(app, 'putClientSettings', {
      as: PERSON.kabir,
      params: { clientId: NORTHWIND },
      body: {
        version: settings.version,
        reminders: { ...DEFAULT_CLIENT_SETTINGS.reminders, ownerDaysBefore: [5, 1] },
      },
    });

    await ok(app, 'listCompanies', { params: { clientId: NORTHWIND } });
    const company = await ok<{ id: string }>(app, 'createCompany', {
      params: { clientId: NORTHWIND },
      body: { name: 'Northwind Logistics Pvt Ltd' },
    });
    await ok(app, 'updateCompany', {
      params: { id: company.id },
      body: { version: 1, name: 'Northwind Logistics Ltd' },
    });
    await ok(app, 'archiveCompany', {
      params: { id: company.id },
      body: { version: 2, reason: 'Merged into the parent' },
    });

    await ok(app, 'listUnits', {
      params: { clientId: NORTHWIND },
      query: { companyId: b('company:northwind') },
    });
    const unit = await ok<{ id: string }>(app, 'createUnit', {
      params: { clientId: NORTHWIND },
      body: {
        companyId: b('company:northwind'),
        name: 'Nashik Depot',
        locationId: b('location:pune'),
      },
    });
    await fails(
      app,
      'createUnit',
      {
        params: { clientId: NORTHWIND },
        body: { companyId: b('company:harbour'), name: 'Wrong', locationId: b('location:pune') },
      },
      'VALIDATION',
      400,
    );
    await ok(app, 'updateUnit', {
      params: { id: unit.id },
      body: { version: 1, name: 'Nashik Warehouse' },
    });
    await ok(app, 'archiveUnit', {
      params: { id: unit.id },
      body: { version: 2, reason: 'Closed' },
    });

    await ok(app, 'listLocations', { query: { stateCode: 'MH' } });
    await ok(app, 'createLocation', {
      body: {
        country: 'India',
        countryCode: 'IN',
        state: 'Maharashtra',
        stateCode: 'MH',
        city: 'Nashik',
      },
    });

    await ok(app, 'listDepartments', {
      as: PERSON.rohan,
      params: { clientId: NORTHWIND },
      query: { q: 'hr' },
    });
    const legal = await ok<{ id: string }>(app, 'createDepartment', {
      params: { clientId: NORTHWIND },
      body: { name: 'Legal' },
    });
    const legalAffairs = await ok<{ id: string }>(app, 'createDepartment', {
      params: { clientId: NORTHWIND },
      body: { name: 'Legal Affairs' },
    });
    await ok(app, 'updateDepartment', {
      params: { id: legal.id },
      body: { version: 1, aliases: ['Law'] },
    });
    const merged = await ok<{ aliases: string[] }>(app, 'mergeDepartments', {
      params: { id: legal.id },
      body: { version: 2, sourceIds: [legalAffairs.id] },
    });
    expect(merged.aliases).toEqual(['Law', 'Legal Affairs']);

    await ok(app, 'listFirmPeople', { query: { q: 'rao' } });
    await fails(app, 'listFirmPeople', { as: PERSON.kabir }, 'FORBIDDEN', 403);
    const people = await ok<{ items: { id: string }[] }>(app, 'listClientPeople', {
      as: PERSON.kabir,
      params: { clientId: NORTHWIND },
    });
    expect(people.items.map((p) => p.id)).toContain(PERSON.rohan);
    const ravi = await ok<{ id: string }>(app, 'createClientPerson', {
      as: PERSON.kabir,
      params: { clientId: NORTHWIND },
      body: { displayName: 'Ravi Kumar' },
    });
    const raviAgain = await ok<{ id: string }>(app, 'createClientPerson', {
      as: PERSON.kabir,
      params: { clientId: NORTHWIND },
      body: { displayName: 'R. Kumar', email: 'ravi.kumar@northwind.example', role: 'APPROVER' },
    });
    const raviMemberships = app.store.firms[1]!.data.memberships.filter(
      (m) => m.personId === raviAgain.id,
    );
    expect(raviMemberships.map((m) => [m.role, m.clientId, m.unitIds])).toEqual([
      ['APPROVER', NORTHWIND, null],
    ]);
    await ok(app, 'updatePerson', {
      params: { id: ravi.id },
      body: { version: 1, displayName: 'Ravi K Kumar' },
    });
    // An email makes an UNCLAIMED person INVITED; clearing it makes them UNCLAIMED again.
    const invited = await ok<{ status: string }>(app, 'updatePerson', {
      params: { id: ravi.id },
      body: { version: 2, email: 'ravi.k@northwind.example' },
    });
    expect(invited.status).toBe('INVITED');
    const unclaimed = await ok<{ status: string }>(app, 'updatePerson', {
      params: { id: ravi.id },
      body: { version: 3, email: null },
    });
    expect(unclaimed.status).toBe('UNCLAIMED');
    await fails(
      app,
      'updatePerson',
      { params: { id: PERSON.sameer }, body: { version: 1, email: null } },
      'VALIDATION',
      400,
    );

    const membership = await ok<{ id: string }>(app, 'createMembership', {
      as: PERSON.kabir,
      params: { id: ravi.id },
      body: {
        role: 'APPROVER',
        clientId: NORTHWIND,
        consultantClientIds: null,
        unitIds: null,
        expiresAt: null,
      },
    });
    await fails(
      app,
      'createMembership',
      {
        as: PERSON.kabir,
        params: { id: ravi.id },
        body: {
          role: 'FIRM_ADMIN',
          clientId: null,
          consultantClientIds: null,
          unitIds: null,
          expiresAt: null,
        },
      },
      'FORBIDDEN',
      403,
    );
    await ok(app, 'mergePeople', {
      as: PERSON.kabir,
      params: { id: ravi.id },
      body: { version: 4, sourceIds: [raviAgain.id] },
    });
    const memberships = await ok<{ items: unknown[] }>(app, 'listMemberships', {
      as: PERSON.kabir,
      params: { id: ravi.id },
    });
    // OWNER from creation and the APPROVER grant; the merged person's APPROVER membership is the same scope.
    expect(memberships.items).toHaveLength(2);
    await ok(app, 'updateMembership', {
      as: PERSON.kabir,
      params: { id: membership.id },
      body: { version: 1, unitIds: [PUNE] },
    });
    await ok(app, 'archiveMembership', {
      as: PERSON.kabir,
      params: { id: membership.id },
      body: { version: 2, reason: 'Left the company' },
    });
    // Kabir cannot see Harbour, so its people do not exist for him.
    await fails(
      app,
      'updatePerson',
      {
        as: PERSON.kabir,
        params: { id: b('person:joseph') },
        body: { version: 1, displayName: 'X' },
      },
      'NOT_FOUND',
      404,
    );
  });

  it('serves the library and assignments, generating instances for a new assignment', async () => {
    const acts = await ok<{ items: unknown[] }>(app, 'listActs', { as: PERSON.kabir });
    const allActs = await ok<{ items: unknown[] }>(app, 'listActs');
    expect(acts.items.length).toBeLessThan(allActs.items.length);
    const act = await ok<{ id: string }>(app, 'createAct', {
      body: { name: 'Payment of Gratuity Act, 1972', jurisdiction: 'CENTRAL' },
    });
    const actCopy = await ok<{ id: string }>(app, 'createAct', {
      body: { name: 'Gratuity Act 1972', jurisdiction: 'CENTRAL' },
    });
    await fails(
      app,
      'updateAct',
      { params: { id: act.id }, body: { version: 1, jurisdiction: 'STATE' } },
      'VALIDATION',
      400,
    );
    await ok(app, 'updateAct', {
      params: { id: act.id },
      body: { version: 1, shortName: 'Gratuity Act' },
    });
    await ok(app, 'mergeActs', {
      params: { id: act.id },
      body: { version: 2, sourceIds: [actCopy.id] },
    });

    await ok(app, 'listCategories', { as: PERSON.rohan });
    const category = await ok<{ id: string }>(app, 'createCategory', {
      body: { name: 'Benefits' },
    });
    const categoryCopy = await ok<{ id: string }>(app, 'createCategory', {
      body: { name: 'Employee Benefits' },
    });
    await ok(app, 'updateCategory', {
      params: { id: category.id },
      body: { version: 1, aliases: ['Perks'] },
    });
    await ok(app, 'mergeCategories', {
      params: { id: category.id },
      body: { version: 2, sourceIds: [categoryCopy.id] },
    });

    const list = await ok<{ items: unknown[] }>(app, 'listObligations', {
      as: PERSON.rohan,
      query: { domain: 'TAX,EHS' },
    });
    expect(list.items.length).toBeGreaterThan(0);
    const obligation = await ok<{ id: string }>(app, 'createObligation', {
      body: {
        externalRef: 'SLC-HRS-099',
        domain: 'HRS',
        jurisdiction: 'CENTRAL',
        stateCode: null,
        actId: act.id,
        categoryId: category.id,
        title: 'Display the gratuity abstract',
        description: 'Display the abstract of the Act at the main entrance.',
        applicabilityText: null,
        criticality: 'LOW',
        timelineType: 'TIME_BASED',
        recurrenceRule: { kind: 'QUARTERLY', anchor: 'AFTER_PERIOD_END', days: 15 },
        ruleStatus: 'CONFIRMED',
        evidenceRequired: false,
        forms: [],
        logSheets: [],
      },
    });
    const updated = await ok<{ libraryVersion: number }>(app, 'updateObligation', {
      params: { id: obligation.id },
      body: { version: 1, criticality: 'MEDIUM' },
    });
    expect(updated.libraryVersion).toBe(2);
    await fails(
      app,
      'getObligation',
      { as: PERSON.rohan, params: { id: obligation.id } },
      'NOT_FOUND',
      404,
    );

    const preview = await ok<{ items: { dueDate: string }[] }>(app, 'previewRule', {
      body: {
        rule: { kind: 'MONTHLY', day: 7, offsetMonths: 1 },
        from: '2024-04-01',
        to: '2025-03-31',
        fyStartMonth: 4,
      },
    });
    expect(preview.items).toHaveLength(12);
    expect(preview.items[0]!.dueDate).toBe('2024-04-07');

    const assignment = await ok<{ id: string; version: number }>(app, 'createAssignment', {
      params: { clientId: NORTHWIND },
      body: {
        unitId: PUNE,
        obligationId: obligation.id,
        departmentId: b('department:hr'),
        defaultOwnerId: PERSON.rohan,
        defaultApproverId: PERSON.nisha,
        activeFrom: '2024-04-01',
      },
    });
    const generated = app.store.firms[1]!.data.instances.filter(
      (i) => i.assignmentId === assignment.id,
    );
    expect(generated.map((i) => i.dueDate)).toEqual([
      '2024-07-15',
      '2024-10-15',
      '2025-01-15',
      '2025-04-15',
    ]);
    await ok(app, 'getObligation', { as: PERSON.rohan, params: { id: obligation.id } });

    const bulk = await ok<{ results: { ok: boolean; error?: { code: string } }[] }>(
      app,
      'bulkCreateAssignments',
      {
        params: { clientId: NORTHWIND },
        body: {
          items: [
            {
              unitId: b('unit:bengaluru'),
              obligationId: obligation.id,
              departmentId: b('department:hr'),
              defaultOwnerId: PERSON.sameer,
              defaultApproverId: b('person:divya'),
              activeFrom: '2024-04-01',
            },
            {
              unitId: PUNE,
              obligationId: obligation.id,
              departmentId: b('department:hr'),
              defaultOwnerId: PERSON.rohan,
              defaultApproverId: PERSON.nisha,
              activeFrom: '2024-04-01',
            },
          ],
        },
      },
    );
    expect(bulk.results.map((r) => r.ok)).toEqual([true, false]);
    expect(bulk.results[1]!.error!.code).toBe('DUPLICATE');

    await ok(app, 'listAssignments', {
      as: PERSON.rohan,
      params: { clientId: NORTHWIND },
      query: { ownerId: 'me' },
    });
    await ok(app, 'updateAssignment', {
      params: { id: assignment.id },
      body: { version: 1, defaultOwnerId: PERSON.sameer, applyToOpen: true },
    });
    expect(
      app.store.firms[1]!.data.instances.filter((i) => i.assignmentId === assignment.id).every(
        (i) => i.ownerId === PERSON.sameer,
      ),
    ).toBe(true);
    await ok(app, 'setAssignmentApplicability', {
      params: { id: assignment.id },
      body: { version: 2, applicability: 'NOT_APPLICABLE', reason: 'No employees eligible yet' },
    });
    await ok(app, 'archiveAssignment', {
      params: { id: assignment.id },
      body: { version: 3, reason: 'Created by mistake' },
    });
    const pushed = await ok<{ assignmentsUpdated: number }>(app, 'pushObligation', {
      params: { id: b('obligation:SLC-TAX-001') },
      body: { clientIds: [NORTHWIND] },
    });
    expect(pushed.assignmentsUpdated).toBe(2);
    await ok(app, 'archiveObligation', {
      params: { id: obligation.id },
      body: { version: 2, reason: 'Superseded' },
    });
  });

  it('runs the workflow with role, state, version and date checks', async () => {
    const register = await ok<{ items: { status: string; dueDate: string }[]; total: number }>(
      app,
      'listInstances',
      {
        as: PERSON.kabir,
        params: { clientId: NORTHWIND },
        query: { status: 'OVERDUE', sort: '-dueDate', limit: '5', count: 'true' },
      },
    );
    expect(register.items).toHaveLength(5);
    expect(register.items.every((r) => r.status === 'OVERDUE')).toBe(true);
    expect(register.total).toBeGreaterThan(5);
    await fails(
      app,
      'listInstances',
      { as: PERSON.kabir, params: { clientId: NORTHWIND }, query: { sort: 'colour' } },
      'VALIDATION',
      400,
    );
    await fails(
      app,
      'listInstances',
      { as: PERSON.kabir, params: { clientId: NORTHWIND }, query: { asOf: '2024-01-01' } },
      'FORBIDDEN',
      403,
    );

    const october = MONTHLY_REGISTER('2024-10-01');
    const detail = await ok<{ allowedActions: string[] }>(app, 'getInstance', {
      as: PERSON.rohan,
      params: { id: october },
    });
    expect(detail.allowedActions).toEqual(
      expect.arrayContaining(['SUBMIT', 'REQUEST_NA', 'COMMENT']),
    );
    await fails(
      app,
      'submitInstance',
      {
        as: PERSON.sameer,
        params: { id: october },
        body: { version: 1, completedOn: '2024-11-14', comment: 'Done.' },
      },
      'FORBIDDEN',
      403,
    );
    await fails(
      app,
      'submitInstance',
      {
        as: PERSON.rohan,
        params: { id: october },
        body: { version: 1, completedOn: '2024-11-16', comment: 'Done.' },
      },
      'DATE_IN_FUTURE',
      422,
    );
    await fails(
      app,
      'submitInstance',
      {
        as: PERSON.rohan,
        params: { id: MONTHLY_REGISTER('2024-11-01') },
        body: { version: 1, completedOn: 'yesterday', comment: 'Done.' },
      },
      'VALIDATION',
      400,
    );
    const submitted = await ok<{ workflowState: string; status: string }>(app, 'submitInstance', {
      as: PERSON.rohan,
      params: { id: october },
      body: { version: 1, completedOn: '2024-11-14', comment: 'Register closed.' },
      headers: { 'idempotency-key': '0b3f6f2e-6a51-4f3b-9d38-1d2f3f5d9a10' },
    });
    expect(submitted).toMatchObject({ workflowState: 'SUBMITTED', status: 'SUBMITTED' });
    // The same Idempotency-Key replays the first response instead of failing on the stale version.
    const replay = await call(app, 'submitInstance', {
      as: PERSON.rohan,
      params: { id: october },
      body: { version: 1, completedOn: '2024-11-14', comment: 'Register closed.' },
      headers: { 'idempotency-key': '0b3f6f2e-6a51-4f3b-9d38-1d2f3f5d9a10' },
    });
    expect(replay.status).toBe(200);
    await fails(
      app,
      'submitInstance',
      {
        as: PERSON.rohan,
        params: { id: october },
        body: { version: 2, completedOn: '2024-11-14', comment: 'Done.' },
      },
      'INVALID_TRANSITION',
      409,
    );

    const november = MONTHLY_REGISTER('2024-11-01');
    await ok(app, 'requestNa', {
      as: PERSON.rohan,
      params: { id: november },
      body: { version: 1, reason: 'Plant shut for maintenance all month.' },
    });
    await fails(
      app,
      'approveInstance',
      { as: PERSON.rohan, params: { id: october }, body: { version: 2 } },
      'FORBIDDEN',
      403,
    );
    const approved = await ok<{ workflowState: string; status: string }>(app, 'approveInstance', {
      as: PERSON.nisha,
      params: { id: october },
      body: { version: 2 },
    });
    // Completed on the 14th against a due date of the 7th.
    expect(approved).toMatchObject({ workflowState: 'APPROVED', status: 'COMPLIED_LATE' });
    await ok(app, 'sendBackInstance', {
      as: PERSON.nisha,
      params: { id: november },
      body: { version: 2, reason: 'Attach the shutdown notice.' },
    });
    await fails(
      app,
      'reopenInstance',
      { as: PERSON.nisha, params: { id: october }, body: { version: 3, reason: 'x' } },
      'FORBIDDEN',
      403,
    );
    await ok(app, 'reopenInstance', {
      as: PERSON.meera,
      params: { id: october },
      body: { version: 3, reason: 'Wrong month closed.' },
    });

    const bulk = await ok<{ results: { id: string; ok: boolean; error?: { code: string } }[] }>(
      app,
      'bulkApprove',
      {
        as: PERSON.kabir,
        params: { clientId: NORTHWIND },
        body: {
          items: [
            { id: TDS_SUBMITTED, version: 2 },
            { id: october, version: 4 },
          ],
        },
      },
    );
    expect(bulk.results.map((r) => [r.ok, r.error?.code])).toEqual([
      [true, undefined],
      [false, 'INVALID_TRANSITION'],
    ]);

    const moved = await ok<{ dueDate: string }>(app, 'updateInstance', {
      as: PERSON.kabir,
      params: { id: MONTHLY_REGISTER('2024-12-01') },
      body: { version: 1, dueDate: '2025-01-10', reason: 'Holiday shutdown' },
    });
    expect(moved.dueDate).toBe('2025-01-10');
    await fails(
      app,
      'updateInstance',
      {
        as: PERSON.kabir,
        params: { id: MONTHLY_REGISTER('2025-01-01') },
        body: { version: 1, dueDate: '2025-02-10' },
      },
      'REASON_REQUIRED',
      422,
    );
    await ok(app, 'updateInstance', {
      as: PERSON.kabir,
      params: { id: MONTHLY_REGISTER('2025-01-01') },
      body: { version: 1, ownerId: PERSON.sameer, reason: 'Rohan moved to Chennai.' },
    });

    const approvals = await ok<{ items: { id: string }[] }>(app, 'myApprovals', {
      as: PERSON.nisha,
    });
    expect(approvals.items.every((r) => r.id !== october)).toBe(true);
    const tasks = await ok<{ items: { ownerId: string }[] }>(app, 'myTasks', {
      as: PERSON.rohan,
      query: { limit: '200' },
    });
    expect(tasks.items.every((r) => r.ownerId === PERSON.rohan)).toBe(true);

    await ok(app, 'createComment', {
      as: PERSON.rohan,
      params: { id: october },
      body: { body: 'Will resubmit tomorrow.' },
    });
    const comments = await ok<{ items: { kind: string }[] }>(app, 'listComments', {
      as: PERSON.nisha,
      params: { id: october },
    });
    expect(comments.items.map((c) => c.kind)).toEqual(['SUBMIT', 'REOPEN', 'NOTE']);
  });

  it('keeps people inside their firm, client and units', async () => {
    const harbourInstance = app.store.firms[1]!.data.instances.find((i) => i.clientId === HARBOUR)!;
    await fails(
      app,
      'getInstance',
      { as: PERSON.kabir, params: { id: harbourInstance.id } },
      'NOT_FOUND',
      404,
    );
    await fails(
      app,
      'getInstance',
      { as: PERSON.leela, params: { id: TDS_SUBMITTED } },
      'NOT_FOUND',
      404,
    );
    await ok(app, 'getInstance', { as: PERSON.leela, params: { id: harbourInstance.id } });
    // Firm A's admin sees nothing of firm B.
    const firmAAdmin = 'admin@demo-advisory.example';
    await fails(
      app,
      'getInstance',
      { as: firmAAdmin, params: { id: TDS_SUBMITTED } },
      'NOT_FOUND',
      404,
    );
    await fails(
      app,
      'listInstances',
      { as: firmAAdmin, params: { clientId: NORTHWIND } },
      'NOT_FOUND',
      404,
    );
    // Rohan owns Pune only.
    const bengaluru = app.store.firms[1]!.data.instances.find(
      (i) => i.unitId === b('unit:bengaluru'),
    )!;
    await fails(
      app,
      'getInstance',
      { as: PERSON.rohan, params: { id: bengaluru.id } },
      'NOT_FOUND',
      404,
    );
    const expired = await fails(
      app,
      'listInstances',
      { as: PERSON.tara, params: { clientId: NORTHWIND } },
      'ACCESS_EXPIRED',
      403,
    );
    expect(expired.error.details).toEqual({ expiredAt: '2024-06-30T18:30:00Z' });
    await ok(app, 'listInstances', {
      as: PERSON.vikram,
      params: { clientId: NORTHWIND },
      query: { asOf: '2024-06-30' },
    });
    await fails(app, 'getMe', { as: null }, 'UNAUTHENTICATED', 401);
    await fails(app, 'getMe', { as: PERSON.gita }, 'UNAUTHENTICATED', 401);
  });

  it('handles evidence uploads, scans, downloads and removal', async () => {
    const instance = MONTHLY_REGISTER('2025-02-01');
    const ticket = await ok<{ uploadId: string; url: string }>(app, 'evidenceUploadUrl', {
      as: PERSON.rohan,
      params: { id: instance },
      body: { fileName: 'register.pdf', mimeType: 'application/pdf', sizeBytes: 1000 },
    });
    expect(ticket.url.startsWith('https://')).toBe(true);
    await fails(
      app,
      'evidenceUploadUrl',
      {
        as: PERSON.rohan,
        params: { id: instance },
        body: { fileName: 'register.exe', mimeType: 'application/octet-stream', sizeBytes: 1000 },
      },
      'UNSUPPORTED_FILE',
      415,
    );
    await fails(
      app,
      'evidenceUploadUrl',
      {
        as: PERSON.rohan,
        params: { id: instance },
        body: {
          fileName: 'register.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 26 * 1024 * 1024,
        },
      },
      'FILE_TOO_LARGE',
      413,
    );
    const evidence = await ok<{ id: string; scanStatus: string }>(app, 'confirmEvidence', {
      as: PERSON.rohan,
      params: { id: instance },
      body: { uploadId: ticket.uploadId, fileName: 'register.pdf', sha256: 'a'.repeat(64) },
    });
    expect(evidence.scanStatus).toBe('PENDING');
    expect(evidence).not.toHaveProperty('storageKey');
    const listed = await ok<{ items: { scanStatus: string }[] }>(app, 'listInstanceEvidence', {
      as: PERSON.rohan,
      params: { id: instance },
    });
    expect(listed.items.map((e) => e.scanStatus)).toEqual(['CLEAN']);

    const pending = app.store.firms[1]!.data.evidence.find((e) => e.scanStatus === 'PENDING')!;
    await fails(
      app,
      'evidenceDownloadUrl',
      { as: PERSON.kabir, params: { id: pending.id } },
      'EVIDENCE_NOT_READY',
      422,
    );
    await ok(app, 'evidenceDownloadUrl', { as: PERSON.kabir, params: { id: evidence.id } });
    const vault = await ok<{ items: unknown[] }>(app, 'evidenceVault', {
      as: PERSON.kabir,
      params: { clientId: NORTHWIND },
      query: { scanStatus: 'CLEAN', unitId: PUNE },
    });
    expect(vault.items.length).toBeGreaterThan(1);
    await ok(app, 'removeEvidence', {
      as: PERSON.rohan,
      params: { id: evidence.id },
      body: { reason: 'Wrong file' },
    });

    // An evidence-required obligation cannot be submitted without clean evidence.
    await fails(
      app,
      'submitInstance',
      {
        as: PERSON.rohan,
        params: { id: instanceId('SLC-TAX-001', 'Pune Plant', '2024-11-01') },
        body: { version: 1, completedOn: '2024-11-14', comment: 'Done.' },
      },
      'EVIDENCE_REQUIRED',
      422,
    );

    const audit = await ok<{ items: { action: string }[] }>(app, 'instanceAudit', {
      as: PERSON.kabir,
      params: { id: instance },
    });
    expect(audit.items.map((e) => e.action)).toEqual(
      expect.arrayContaining(['EVIDENCE_ADD', 'EVIDENCE_DOWNLOAD', 'EVIDENCE_REMOVE']),
    );
    const clientAudit = await ok<{ items: { action: string }[] }>(app, 'clientAudit', {
      params: { clientId: NORTHWIND },
      query: { action: 'TRANSITION', from: '2024-11-15T00:00:00Z' },
    });
    expect(clientAudit.items.length).toBeGreaterThan(0);
    await fails(
      app,
      'clientAudit',
      { as: PERSON.rohan, params: { clientId: NORTHWIND } },
      'FORBIDDEN',
      403,
    );
  });

  it('walks an import through every step', async () => {
    const ticket = await ok<{ batchId: string }>(app, 'createImport', {
      params: { clientId: NORTHWIND },
      body: { fileName: 'register.xlsx', sizeBytes: 50_000 },
    });
    await fails(app, 'getImport', { params: { id: ticket.batchId } }, 'NOT_FOUND', 404);
    const uploaded = await ok<{ suggestedMapping: unknown[]; sheets: { name: string }[] }>(
      app,
      'importUploaded',
      { params: { id: ticket.batchId }, body: { sha256: 'b'.repeat(64) } },
    );
    expect(uploaded.sheets[0]!.name).toBe(SAMPLE_SHEET);
    await fails(app, 'parseImport', { params: { id: ticket.batchId } }, 'IMPORT_STATE', 409);
    const mapping = SAMPLE_COLUMNS.map(([sourceHeader, field]) => ({ sourceHeader, field }));
    await ok(app, 'putImportMapping', {
      params: { id: ticket.batchId },
      body: {
        sheetName: SAMPLE_SHEET,
        mapping,
        saveAsTemplate: { name: 'Register export', scope: 'CLIENT' },
      },
    });
    const parsed = await ok<{ counts: { rows: number } }>(app, 'parseImport', {
      params: { id: ticket.batchId },
    });
    expect(parsed.counts.rows).toBe(422);
    await ok(app, 'getImport', { params: { id: ticket.batchId } });
    // A dry run works with undecided warnings; the commit is what they block.
    await ok(app, 'dryRunImport', { params: { id: ticket.batchId } });
    await fails(app, 'commitImport', { params: { id: ticket.batchId } }, 'IMPORT_BLOCKED', 422);

    const issues = await ok<{
      items: { groupKey: string; severity: string; proposal: string | null }[];
    }>(app, 'listImportIssues', { params: { id: ticket.batchId }, query: { severity: 'WARNING' } });
    for (const group of issues.items) {
      await ok(app, 'decideImportIssue', {
        params: { id: ticket.batchId, groupKey: group.groupKey },
        body: group.proposal === null ? { decision: 'REJECTED' } : { decision: 'ACCEPTED' },
      });
    }
    const rows = await ok<{ items: unknown[] }>(app, 'listImportRows', {
      params: { id: ticket.batchId },
      query: { issueType: 'DUPLICATE_PERIOD' },
    });
    expect(rows.items.length).toBeGreaterThan(0);
    const report = await ok<{ create: { instances: number } }>(app, 'dryRunImport', {
      params: { id: ticket.batchId },
    });
    expect(report.create.instances).toBe(422);
    const committed = await ok<{ status: string }>(app, 'commitImport', {
      params: { id: ticket.batchId },
      headers: { 'idempotency-key': '6a1d4e1c-3d0f-4a5e-8f39-0c7a2b5f9e11' },
    });
    expect(committed.status).toBe('COMMITTED');
    // Commit is idempotent, with or without a key.
    const recommitted = await ok<{ status: string }>(app, 'commitImport', {
      params: { id: ticket.batchId },
    });
    expect(recommitted.status).toBe('COMMITTED');
    await fails(app, 'cancelImport', { params: { id: ticket.batchId } }, 'IMPORT_STATE', 409);

    const second = await ok<{ batchId: string }>(app, 'createImport', {
      params: { clientId: NORTHWIND },
      body: { fileName: 'again.xlsx', sizeBytes: 50_000 },
    });
    const again = await ok<{ suggestedTemplateId: string | null }>(app, 'importUploaded', {
      params: { id: second.batchId },
      body: { sha256: 'c'.repeat(64) },
    });
    expect(again.suggestedTemplateId).not.toBeNull();
    await ok(app, 'cancelImport', { params: { id: second.batchId } });
    const batches = await ok<{ items: unknown[] }>(app, 'listImports', {
      params: { clientId: NORTHWIND },
    });
    expect(batches.items).toHaveLength(2);

    const template = await ok<{ id: string }>(app, 'createMappingTemplate', {
      params: { clientId: NORTHWIND },
      body: { name: 'Firm default', mapping, scope: 'FIRM' },
    });
    await ok(app, 'updateMappingTemplate', {
      params: { id: template.id },
      body: { version: 1, name: 'Firm register' },
    });
    const templates = await ok<{ items: unknown[] }>(app, 'listMappingTemplates', {
      params: { clientId: HARBOUR },
    });
    expect(templates.items).toHaveLength(1);
    await fails(
      app,
      'createImport',
      {
        as: PERSON.kabir,
        params: { clientId: NORTHWIND },
        body: { fileName: 'x.xlsx', sizeBytes: 10 },
      },
      'FORBIDDEN',
      403,
    );
  });

  it('serves dashboards, reports and exports', async () => {
    const portfolio = await ok<{
      items: { clientId: string; dueThisWeek: number; dueThisWeekFilter: unknown }[];
    }>(app, 'portfolio', { as: PERSON.arjun });
    expect(portfolio.items.map((r) => r.clientId)).toEqual([NORTHWIND]);
    // The filter lists exactly the items counted as due this week.
    const week = portfolio.items[0]!;
    expect(week.dueThisWeekFilter).toEqual({
      dueFrom: TODAY,
      dueTo: '2024-11-21',
      workflowState: ['OPEN', 'SENT_BACK'],
    });
    const filtered = await ok<{ items: unknown[] }>(app, 'listInstances', {
      as: PERSON.arjun,
      params: { clientId: NORTHWIND },
      query: { dueFrom: TODAY, dueTo: '2024-11-21', workflowState: 'OPEN,SENT_BACK', limit: '200' },
    });
    expect(filtered.items).toHaveLength(week.dueThisWeek);
    const overview = await ok<{ myTasks: { ownerId: string }[] }>(app, 'clientOverview', {
      as: PERSON.rohan,
      params: { clientId: NORTHWIND },
      query: { fy: '2024-25' },
    });
    expect(overview.myTasks.every((r) => r.ownerId === PERSON.rohan)).toBe(true);
    // At firm B's as-of date the overview score and its counts agree, and every row stays inside the period asked for.
    const quarter = await ok<{
      result: { score: number | null; counts: { COMPLIED: number; OVERDUE: number } };
      upcoming: { dueDate: string }[];
    }>(app, 'clientOverview', {
      params: { clientId: NORTHWIND },
      query: { from: '2024-10-01', to: '2024-12-31' },
    });
    expect(quarter.result.counts.COMPLIED + quarter.result.counts.OVERDUE).toBeGreaterThan(0);
    expect(quarter.result.score).not.toBeNull();
    expect(quarter.upcoming.length).toBeGreaterThan(0);
    for (const row of quarter.upcoming) {
      expect(row.dueDate >= TODAY && row.dueDate <= '2024-12-31').toBe(true);
    }
    await ok(app, 'breakdown', {
      as: PERSON.kabir,
      params: { clientId: NORTHWIND },
      query: { by: 'owner', unitId: PUNE },
    });
    const calendar = await ok<{ items: { date: string }[] }>(app, 'calendar', {
      as: PERSON.kabir,
      params: { clientId: NORTHWIND },
      query: { from: '2024-02-01', to: '2024-02-29' },
    });
    expect(calendar.items.map((d) => d.date)).toContain('2024-02-29');
    await ok(app, 'actReport', { as: PERSON.vikram, params: { clientId: NORTHWIND } });
    await ok(app, 'departmentReport', { as: PERSON.nisha, params: { clientId: NORTHWIND } });
    const overdue = await ok<{ items: { status: string }[] }>(app, 'overdueReport', {
      as: PERSON.kabir,
      params: { clientId: NORTHWIND },
    });
    expect(overdue.items.every((r) => r.status === 'OVERDUE')).toBe(true);
    await fails(
      app,
      'overdueReport',
      { as: PERSON.rohan, params: { clientId: NORTHWIND } },
      'FORBIDDEN',
      403,
    );

    await fails(
      app,
      'createExport',
      {
        as: PERSON.kabir,
        params: { clientId: NORTHWIND },
        body: { kind: 'REGISTER_XLSX', filters: 'status=LATE' },
      },
      'VALIDATION',
      400,
    );
    const job = await ok<{ id: string; status: string }>(app, 'createExport', {
      as: PERSON.kabir,
      params: { clientId: NORTHWIND },
      body: { kind: 'REGISTER_XLSX', filters: 'status=OVERDUE&unitId=' + PUNE },
    });
    expect(job.status).toBe('DONE');
    await ok(app, 'getExport', { as: PERSON.kabir, params: { id: job.id } });
    await ok(app, 'exportDownloadUrl', { as: PERSON.kabir, params: { id: job.id } });
  });

  it('answers unknown routes and bad JSON with the error envelope and a request id', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/nowhere',
      headers: { 'x-request-id': 'req-123' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['x-request-id']).toBe('req-123');
    expect(ApiErrorResponse.parse(JSON.parse(missing.body)).requestId).toBe('req-123');
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    expect(bad.statusCode).toBe(400);
  });

  it('resets to the fixtures', async () => {
    const reset = await app.inject({ method: 'POST', url: '/__mock/reset' });
    expect(reset.statusCode).toBe(204);
    expect(
      app.store.firms[1]!.data.instances.find((i) => i.id === MONTHLY_REGISTER('2024-10-01'))!
        .workflowState,
    ).toBe('OPEN');
    const people = await app.inject({ method: 'GET', url: '/__mock/people' });
    expect((JSON.parse(people.body) as { items: unknown[] }).items.length).toBeGreaterThan(10);
    const outbox = await app.inject({ method: 'GET', url: '/__mock/outbox' });
    expect(JSON.parse(outbox.body)).toEqual({ items: [] });
  });
});

describe('mock server golden numbers (fixtures.md §4)', () => {
  it('reports firm A scores that match firm-a.expected.json', async () => {
    const app = createMockServer({ today: '2023-04-10' });
    const expected = loadExpected();
    const clientId = fixtureId('firm-a:client');
    for (const s of expected.profiles.recommended.scores) {
      const response = await call(app, 'clientOverview', {
        as: 'admin@demo-advisory.example',
        params: { clientId },
        query: { fy: '2022-23', asOf: s.asOf },
      });
      const result = (
        response.json as { result: { score: number; onTimeRate: number; counts: unknown } }
      ).result;
      expect(result).toMatchObject({ score: s.score, onTimeRate: s.onTimeRate, counts: s.counts });
    }
    const breakdown = await call(app, 'breakdown', {
      as: 'admin@demo-advisory.example',
      params: { clientId },
      query: { by: 'department', asOf: '2023-03-31' },
    });
    const rows = (breakdown.json as { rows: { label: string; result: { score: number } }[] }).rows;
    const golden = expected.breakdowns.find(
      (x) => x.by === 'department' && x.asOf === '2023-03-31',
    )!.rows;
    expect(rows.map((r) => [r.label, r.result.score])).toEqual(
      golden.map((r) => [r.label, r.result.score]),
    );
    await app.close();
  });
});

describe('mock server: scope, ordering and audit details', () => {
  let app: App;
  const firmB = () => app.store.firms[1]!.data;
  const instanceWhere = (test: (i: ReturnType<typeof firmB>['instances'][number]) => boolean) =>
    firmB().instances.find(test)!;
  beforeAll(async () => {
    app = createMockServer({ today: TODAY });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('lets an approver bulk-approve their own items and refuses others per item', async () => {
    const divya = b('person:divya');
    const own = instanceWhere((i) => i.workflowState === 'SUBMITTED' && i.approverId === divya);
    const result = await ok<{ results: { id: string; ok: boolean; error?: { code: string } }[] }>(
      app,
      'bulkApprove',
      {
        as: divya,
        params: { clientId: NORTHWIND },
        body: {
          items: [
            { id: own.id, version: own.version },
            { id: TDS_SUBMITTED, version: 2 },
          ],
        },
      },
    );
    expect(result.results.map((r) => [r.ok, r.error?.code])).toEqual([
      [true, undefined],
      [false, 'FORBIDDEN'],
    ]);
    expect(firmB().auditEvents.findLast((e) => e.entityId === own.id)!.after).toMatchObject({
      workflowState: 'NOT_APPLICABLE',
      delegated: false,
    });

    // A client admin approves as a delegate.
    await ok(app, 'approveInstance', {
      as: PERSON.kabir,
      params: { id: TDS_SUBMITTED },
      body: { version: 2 },
    });
    expect(firmB().auditEvents.findLast((e) => e.entityId === TDS_SUBMITTED)!.after).toMatchObject({
      workflowState: 'APPROVED',
      delegated: true,
    });
  });

  it('checks version and state before the submission rules', async () => {
    const approved = instanceWhere(
      (i) => i.workflowState === 'APPROVED' && i.clientId === NORTHWIND,
    );
    await fails(
      app,
      'submitInstance',
      {
        as: approved.ownerId,
        params: { id: approved.id },
        body: { version: approved.version, completedOn: TODAY, comment: 'Done.' },
      },
      'INVALID_TRANSITION',
      409,
    );
    await fails(
      app,
      'confirmEvidence',
      {
        as: approved.ownerId,
        params: { id: approved.id },
        body: {
          uploadId: '00000000-0000-4000-8000-000000000000',
          fileName: 'late.pdf',
          sha256: 'b'.repeat(64),
        },
      },
      'INVALID_TRANSITION',
      409,
    );
  });

  it('names the product, not the working name, in the MFA enrolment', async () => {
    const { otpauthUrl } = await ok<{ otpauthUrl: string }>(app, 'enrollMfa', {
      as: PERSON.meera,
    });
    expect(otpauthUrl).toContain('issuer=PlanetPulse%20Compliance');
    expect(otpauthUrl).not.toMatch(/canopy/i);
  });

  it('keeps people management inside the actor’s clients', async () => {
    const staff = await ok<{ items: { id: string }[] }>(app, 'listFirmPeople', {
      as: PERSON.meera,
    });
    expect(staff.items.map((p) => p.id).sort()).toEqual(
      [PERSON.meera, PERSON.arjun, PERSON.leela].sort(),
    );

    const grant = {
      role: 'OWNER',
      clientId: NORTHWIND,
      consultantClientIds: null,
      unitIds: null,
      expiresAt: null,
    };
    for (const person of [PERSON.arjun, b('person:priya')]) {
      await fails(
        app,
        'createMembership',
        { as: PERSON.kabir, params: { id: person }, body: grant },
        'NOT_FOUND',
        404,
      );
    }

    // One source outside the client fails the whole merge, and nothing changes.
    const target = firmB().people.find((p) => p.id === PERSON.farhan)!;
    const ishaan = b('person:ishaan');
    await fails(
      app,
      'mergePeople',
      {
        as: PERSON.kabir,
        params: { id: target.id },
        body: { version: target.version, sourceIds: [ishaan, b('person:priya')] },
      },
      'VALIDATION',
      400,
    );
    expect(firmB().people.find((p) => p.id === ishaan)!.archivedAt).toBeNull();

    const sameersWork = firmB().instances.filter(
      (i) => i.ownerId === PERSON.sameer || i.approverId === PERSON.sameer,
    ).length;
    expect(sameersWork).toBeGreaterThan(0);
    const before = firmB().auditEvents.length;
    await ok(app, 'mergePeople', {
      as: PERSON.kabir,
      params: { id: target.id },
      body: { version: target.version, sourceIds: [PERSON.sameer] },
    });
    const written = firmB().auditEvents.slice(before);
    expect(written.filter((e) => e.action === 'REASSIGN')).toHaveLength(sameersWork);
    expect(written.at(-1)!.action).toBe('MERGE_ALIAS');
  });

  it('answers the import and file error codes at the right step', async () => {
    await fails(
      app,
      'createImport',
      { params: { clientId: NORTHWIND }, body: { fileName: 'register.csv', sizeBytes: 1000 } },
      'UNSUPPORTED_FILE',
      415,
    );
    const tooBig = await fails(
      app,
      'createImport',
      {
        params: { clientId: NORTHWIND },
        body: { fileName: 'register.xlsx', sizeBytes: 21 * 1024 * 1024 },
      },
      'FILE_TOO_LARGE',
      413,
    );
    expect(tooBig.error.details).toEqual({ maxBytes: 20 * 1024 * 1024 });
  });
});
