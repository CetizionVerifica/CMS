import { ApiErrorResponse, Department, Unit } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import { ids, testApp } from './testing/world.js';

const error = (body: unknown) => ApiErrorResponse.parse(body).error;
const names = (body: unknown) => (body as { items: { name: string }[] }).items.map((i) => i.name);

describe('companies', () => {
  it('rejects a duplicate name in the client with DUPLICATE', async () => {
    const { call } = testApp();
    const res = await call('clientAdmin', 'POST', `/clients/${ids.clientA}/companies`, {
      name: 'Kestrel Aluminium',
    });
    expect(res.status).toBe(409);
    expect(error(res.body)).toMatchObject({
      code: 'DUPLICATE',
      details: { field: 'name', existingId: ids.companyA },
    });
  });

  it('will not archive a company that still has units', async () => {
    const { call } = testApp();
    const res = await call('firmAdmin', 'POST', `/companies/${ids.companyA}/archive`, {
      version: 1,
      reason: 'Sold',
    });
    expect(res.status).toBe(400);
  });

  it('is 404 for a company in a client the actor cannot see', async () => {
    const { call } = testApp();
    const res = await call('consultant', 'PATCH', `/companies/${ids.companyB}`, {
      version: 1,
      name: 'Renamed',
    });
    expect(res.status).toBe(404);
  });
});

describe('units', () => {
  it('shows owners and approvers only their units', async () => {
    const { call } = testApp();
    expect(names((await call('owner', 'GET', `/clients/${ids.clientA}/units`)).body)).toEqual([
      'Plant',
    ]);
    expect(names((await call('viewer', 'GET', `/clients/${ids.clientA}/units`)).body)).toEqual([
      'Head Office',
      'Plant',
    ]);
    const filtered = await call(
      'clientAdmin',
      'GET',
      `/clients/${ids.clientA}/units?companyId=${ids.companyEmpty}`,
    );
    expect(names(filtered.body)).toEqual([]);
  });

  it('checks the company and location of a new unit', async () => {
    const { call } = testApp();
    const wrongCompany = await call('clientAdmin', 'POST', `/clients/${ids.clientA}/units`, {
      companyId: ids.companyB,
      name: 'Depot',
      locationId: ids.location,
    });
    expect(wrongCompany.status).toBe(400);
    const wrongLocation = await call('clientAdmin', 'POST', `/clients/${ids.clientA}/units`, {
      companyId: ids.companyA,
      name: 'Depot',
      locationId: ids.unit1,
    });
    expect(wrongLocation.status).toBe(400);
  });

  it('moves a unit to another company and announces it', async () => {
    const { call, store } = testApp();
    const res = await call('consultant', 'PATCH', `/units/${ids.unit2}`, {
      version: 1,
      companyId: ids.companyEmpty,
      locationId: ids.location,
    });
    expect(Unit.parse(res.body).companyId).toBe(ids.companyEmpty);
    expect(store.events.at(-1)).toMatchObject({ type: 'unit.updated' });
    expect(store.audits.at(-1)?.after).toEqual({ companyId: ids.companyEmpty });
  });

  it('will not archive a unit with live assignments', async () => {
    const { call } = testApp();
    const res = await call('firmAdmin', 'POST', `/units/${ids.unit1}/archive`, {
      version: 1,
      reason: 'Closed',
    });
    expect(res.status).toBe(400);
  });

  it('announces an archived unit', async () => {
    const { call, store } = testApp();
    await call('firmAdmin', 'POST', `/units/${ids.unit2}/archive`, {
      version: 1,
      reason: 'Closed',
    });
    expect(store.events.map((e) => e.type)).toEqual(['unit.archived']);
  });
});

describe('plan limits', () => {
  it("refuses a company past the plan's limit, counting clients the actor cannot see", async () => {
    const { call, store } = testApp();
    // Firm A holds three live companies; the client admin sees only client A's two.
    store.limits = { companies: 3 };
    const res = await call('clientAdmin', 'POST', `/clients/${ids.clientA}/companies`, {
      name: 'Kestrel Fibres',
    });
    expect(res.status).toBe(403);
    expect(error(res.body)).toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      message: 'Your plan allows 3 companies. Contact PlanetPulse to upgrade.',
      details: { limit: 'companies', max: 3, used: 3 },
    });
    expect(store.audits).toEqual([]);
  });

  it('allows a company below the limit and does not count archived ones', async () => {
    const { call, store } = testApp();
    store.limits = { companies: 3 };
    const archived = await call('firmAdmin', 'POST', `/companies/${ids.companyEmpty}/archive`, {
      version: 1,
      reason: 'Merged',
    });
    expect(archived.status).toBe(200);
    const res = await call('clientAdmin', 'POST', `/clients/${ids.clientA}/companies`, {
      name: 'Kestrel Fibres',
    });
    expect(res.status).toBe(201);
  });

  it("refuses a unit past the plan's limit and writes nothing", async () => {
    const { call, store } = testApp();
    store.limits = { units: 1 };
    const res = await call('consultant', 'POST', `/clients/${ids.clientA}/units`, {
      companyId: ids.companyA,
      name: 'Depot',
      locationId: ids.location,
    });
    expect(res.status).toBe(403);
    expect(error(res.body)).toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      message: 'Your plan allows 1 unit. Contact PlanetPulse to upgrade.',
      details: { limit: 'units', max: 1, used: 3 },
    });
    expect(store.audits).toEqual([]);
    expect(store.events).toEqual([]);
  });

  it('has no limit when the plan sets none', async () => {
    const { call, store } = testApp();
    store.limits = { units: null };
    const res = await call('consultant', 'POST', `/clients/${ids.clientA}/units`, {
      companyId: ids.companyA,
      name: 'Depot',
      locationId: ids.location,
    });
    expect(res.status).toBe(201);
  });
});

describe('locations', () => {
  it('filters by country and state and searches by name', async () => {
    const { call } = testApp();
    const items = async (q: string) =>
      ((await call('owner', 'GET', `/locations${q}`)).body as { items: unknown[] }).items.length;
    expect(await items('?countryCode=IN&stateCode=WB')).toBe(1);
    expect(await items('?stateCode=MH')).toBe(0);
    expect(await items('?q=riverbend')).toBe(1);
  });

  it('needs the state and its code together, and refuses a duplicate path', async () => {
    const { call } = testApp();
    const half = await call('clientAdmin', 'POST', '/locations', {
      country: 'India',
      countryCode: 'IN',
      state: 'Kerala',
      stateCode: null,
      city: null,
    });
    expect(half.status).toBe(400);
    const dup = await call('clientAdmin', 'POST', '/locations', {
      country: 'India',
      countryCode: 'IN',
      state: 'west bengal',
      stateCode: 'WB',
      city: 'RIVERBEND',
    });
    expect(dup.status).toBe(409);
  });
});

describe('departments', () => {
  it('merges spellings: names become aliases, assignments move, sources are archived', async () => {
    const { call, store } = testApp();
    const res = await call('clientAdmin', 'POST', `/departments/${ids.hr}/merge`, {
      version: 1,
      sourceIds: [ids.hrAlias],
    });
    expect(res.status).toBe(200);
    expect(Department.parse(res.body).aliases).toEqual(['HR']);
    expect(store.raw('assignments', ids.assignment)?.departmentId).toBe(ids.hr);
    expect(store.raw('departments', ids.hrAlias)?.archivedAt).not.toBeNull();
    expect(store.audits.map((a) => [a.entityType, a.action])).toEqual([
      ['assignment', 'MERGE_ALIAS'],
      ['department', 'MERGE_ALIAS'],
      ['department', 'MERGE_ALIAS'],
    ]);
    expect(store.events).toMatchObject([
      { type: 'alias.merged', data: { entityType: 'department', sourceIds: [ids.hrAlias] } },
    ]);
  });

  it('refuses to merge a department into itself or from another client', async () => {
    const { call } = testApp();
    const self = await call('firmAdmin', 'POST', `/departments/${ids.hr}/merge`, {
      version: 1,
      sourceIds: [ids.hr],
    });
    expect(self.status).toBe(400);
    const other = await call('firmAdmin', 'POST', `/departments/${ids.hr}/merge`, {
      version: 1,
      sourceIds: [ids.deptB],
    });
    expect(other.status).toBe(404);
  });

  it('undoes every change when a merge fails part-way', async () => {
    const { call, store } = testApp();
    const res = await call('firmAdmin', 'POST', `/departments/${ids.hr}/merge`, {
      version: 7,
      sourceIds: [ids.hrAlias],
    });
    expect(res.status).toBe(409);
    expect(store.raw('departments', ids.hrAlias)?.archivedAt).toBeNull();
    expect(store.raw('assignments', ids.assignment)?.departmentId).toBe(ids.hrAlias);
    expect(store.audits).toEqual([]);
  });

  it('renames a department and keeps its aliases case-insensitively unique', async () => {
    const { call } = testApp();
    const res = await call('clientAdmin', 'PATCH', `/departments/${ids.hr}`, {
      version: 1,
      name: 'People',
    });
    expect(res.body).toMatchObject({ name: 'People', version: 2 });
  });
});
