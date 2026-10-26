import type { ComplianceInstance, Evidence } from '@canopy/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accountView, createTestAuth } from '../../auth/testing.js';
import { buildServer } from '../../server.js';
import { createMemoryStorage } from '../evidence/testing/storage.js';
import {
  addEvidence,
  addInstance,
  addIsoAssignment,
  createTestDb,
  seedFixture,
  type Cast,
  type Fixture,
  type TestDb,
} from './testing/fixture.js';

/**
 * ISO-11a: the ISO add-on's off switch and the `source` filter on M7's routes (docs/iso/plan.md §4.4-4.6), against
 * Postgres with RLS on. With the add-on off, the instance list, `/me/approvals`, `/me/tasks` and the evidence vault
 * leave STANDARD instances out whatever `source` says, every route that names one answers 403 `FEATURE_NOT_ENABLED`
 * (each route's no-write check is in audit-gate.db.test.ts), and the client audit trail still lists their events.
 * With it on, `source=LAW` reads STATUTE acts, `source=ISO` STANDARD acts, and no `source` both. Today is 2023-01-20.
 */

const NOW = new Date('2023-01-20T06:00:00Z');
const OFF = { code: 'FEATURE_NOT_ENABLED', details: { feature: 'isoManagement' } };
const ROLES = ['firmAdmin', 'consultant', 'clientAdmin', 'approver', 'owner', 'viewer'] as const;

let testDb: TestDb;
let app: FastifyInstance;
let f: Fixture;
const auth = createTestAuth();
const headers = {} as Record<keyof Cast, Record<string, string>>;
const law = {} as { open: ComplianceInstance; submitted: ComplianceInstance; file: Evidence };
const iso = {} as { open: ComplianceInstance; submitted: ComplianceInstance; file: Evidence };

function setIso(on: boolean): void {
  const view = accountView(f.firmId);
  auth.store.accounts.set(f.firmId, {
    ...view,
    entitlements: { ...view.entitlements, features: on ? ['isoManagement'] : [] },
  });
}

beforeAll(async () => {
  testDb = await createTestDb();
  f = await seedFixture(testDb.db, await testDb.createFirm('Switch firm'), 'S');
  for (const key of Object.keys(f.people) as (keyof Cast)[]) {
    headers[key] = auth.signIn({
      firmId: f.firmId,
      personId: f.people[key],
      memberships: f.memberships[key],
      principal: { firmClientIds: [f.clientId] },
    }).headers;
  }
  const isoAssignment = await addIsoAssignment(testDb.db, f);
  const add = (periodStart: string, state: 'OPEN' | 'SUBMITTED', assignmentId?: string) =>
    addInstance(testDb.db, f, {
      ...(assignmentId === undefined ? {} : { assignmentId }),
      periodStart,
      dueDate: '2023-02-15',
      state,
    });
  law.open = await add('2022-01-01', 'OPEN');
  law.submitted = await add('2021-01-01', 'SUBMITTED');
  iso.open = await add('2022-01-01', 'OPEN', isoAssignment);
  iso.submitted = await add('2021-01-01', 'SUBMITTED', isoAssignment);
  law.file = await addEvidence(testDb.db, f, law.submitted);
  iso.file = await addEvidence(testDb.db, f, iso.submitted);
  app = buildServer({
    authStore: auth.store,
    database: testDb.db,
    evidenceStorage: createMemoryStorage().storage,
    clock: () => NOW,
    rateLimit: { max: 100_000, timeWindow: '1 minute' },
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
});

async function call(
  who: keyof Cast,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: object,
) {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: headers[who],
    ...(payload === undefined ? {} : { payload }),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

/** The ids a list route returns. */
async function ids(who: keyof Cast, url: string): Promise<string[]> {
  const res = await call(who, 'GET', url);
  expect(res.status).toBe(200);
  return (res.body.items as { id: string }[]).map((item) => item.id);
}

const register = 'instances';
const vault = 'evidence';
/** A client list route, with `source` when given. */
const url = (list: string, source?: 'LAW' | 'ISO') =>
  `/clients/${f.clientId}/${list}${source === undefined ? '' : `?source=${source}`}`;

describe('with the ISO add-on off', () => {
  beforeEach(() => setIso(false));

  it.each(ROLES)(
    'the instance list leaves STANDARD instances out for %s, whatever source says',
    async (who) => {
      for (const source of [undefined, 'LAW', 'ISO'] as const) {
        const listed = await ids(who, url(register, source));
        expect(listed).toEqual(expect.arrayContaining([law.open.id, law.submitted.id]));
        expect(listed).not.toContain(iso.open.id);
        expect(listed).not.toContain(iso.submitted.id);
      }
    },
  );

  it.each(['approver', 'clientAdmin'] as const)(
    '/me/approvals leaves them out for %s',
    async (who) => {
      for (const query of ['', '?source=ISO']) {
        const listed = await ids(who, `/me/approvals${query}`);
        expect(listed).toContain(law.submitted.id);
        expect(listed).not.toContain(iso.submitted.id);
      }
    },
  );

  it('/me/tasks leaves them out', async () => {
    for (const query of ['', '?source=ISO']) {
      const listed = await ids('owner', `/me/tasks${query}`);
      expect(listed).toContain(law.open.id);
      expect(listed).not.toContain(iso.open.id);
    }
  });

  it.each(['firmAdmin', 'clientAdmin', 'owner', 'viewer'] as const)(
    'the evidence vault leaves their files out for %s',
    async (who) => {
      for (const source of [undefined, 'ISO'] as const) {
        const listed = await ids(who, url(vault, source));
        expect(listed).toContain(law.file.id);
        expect(listed).not.toContain(iso.file.id);
      }
    },
  );

  it.each([...ROLES, 'otherOwner'] as const)(
    'every route naming a STANDARD instance answers 403 for %s, and a law instance does not',
    async (who) => {
      for (const path of [
        `/instances/${iso.submitted.id}`,
        `/instances/${iso.submitted.id}/comments`,
        `/instances/${iso.submitted.id}/evidence`,
        `/instances/${iso.submitted.id}/audit`,
        `/evidence/${iso.file.id}/download-url`,
      ]) {
        const res = await call(who, 'GET', path);
        expect(res.status, path).toBe(403);
        expect(res.body.error).toMatchObject(OFF);
      }
      const lawRead = await call(who, 'GET', `/instances/${law.open.id}`);
      expect(lawRead.body).not.toMatchObject({ error: OFF });
    },
  );

  it('refuses the switch before the role check, on writes too', async () => {
    const approve = await call('approver', 'POST', `/instances/${iso.submitted.id}/approve`, {
      version: iso.submitted.version,
    });
    expect(approve).toMatchObject({ status: 403, body: { error: OFF } });
    const viewerWrite = await call('viewer', 'POST', `/instances/${iso.open.id}/comments`, {
      body: 'A note.',
    });
    expect(viewerWrite).toMatchObject({ status: 403, body: { error: OFF } });
  });

  it('bulk approve refuses a STANDARD item and approves the law item beside it', async () => {
    const lawItem = await addInstance(testDb.db, f, {
      periodStart: '2019-01-01',
      dueDate: '2023-02-15',
      state: 'SUBMITTED',
    });
    const res = await call('approver', 'POST', `/clients/${f.clientId}/instances/bulk-approve`, {
      items: [
        { id: iso.submitted.id, version: iso.submitted.version },
        { id: lawItem.id, version: lawItem.version },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      {
        id: iso.submitted.id,
        ok: false,
        error: { code: 'FEATURE_NOT_ENABLED', message: expect.any(String) },
      },
      expect.objectContaining({ id: lawItem.id, ok: true }),
    ]);
  });
});

describe('with the ISO add-on on', () => {
  beforeEach(() => setIso(true));

  it.each(ROLES)('the instance list reads both kinds, LAW or ISO for %s', async (who) => {
    const all = await ids(who, url(register));
    expect(all).toEqual(expect.arrayContaining([law.open.id, iso.open.id]));
    const lawOnly = await ids(who, url(register, 'LAW'));
    expect(lawOnly).toContain(law.open.id);
    expect(lawOnly).not.toContain(iso.open.id);
    const isoOnly = await ids(who, url(register, 'ISO'));
    expect(isoOnly).toContain(iso.open.id);
    expect(isoOnly).not.toContain(law.open.id);
  });

  it('the queues and the vault take source', async () => {
    expect(await ids('approver', '/me/approvals')).toEqual(
      expect.arrayContaining([law.submitted.id, iso.submitted.id]),
    );
    expect(await ids('approver', '/me/approvals?source=ISO')).not.toContain(law.submitted.id);
    expect(await ids('approver', '/me/approvals?source=LAW')).not.toContain(iso.submitted.id);
    expect(await ids('owner', '/me/tasks?source=ISO')).toContain(iso.open.id);
    expect(await ids('owner', '/me/tasks?source=LAW')).not.toContain(iso.open.id);
    expect(await ids('owner', url(vault))).toEqual(
      expect.arrayContaining([law.file.id, iso.file.id]),
    );
    expect(await ids('owner', url(vault, 'ISO'))).toEqual([iso.file.id]);
    expect(await ids('owner', url(vault, 'LAW'))).not.toContain(iso.file.id);
  });

  it('works a STANDARD instance; switched off it is refused, switched back it is as it was', async () => {
    const changed = await call('clientAdmin', 'PATCH', `/instances/${iso.open.id}`, {
      version: iso.open.version,
      dueDate: '2023-03-01',
      reason: 'Drill moved to March.',
    });
    expect(changed.status).toBe(200);
    const before = await call('owner', 'GET', `/instances/${iso.open.id}`);
    expect(before.status).toBe(200);

    setIso(false);
    expect(await call('owner', 'GET', `/instances/${iso.open.id}`)).toMatchObject({
      status: 403,
      body: { error: OFF },
    });
    // The client trail is not gated: the change is still listed.
    const trail = await call(
      'clientAdmin',
      'GET',
      `/clients/${f.clientId}/audit?entityId=${iso.open.id}`,
    );
    expect(trail.status).toBe(200);
    expect((trail.body.items as { action: string }[]).map((e) => e.action)).toContain(
      'DUE_DATE_CHANGE',
    );

    setIso(true);
    expect(await call('owner', 'GET', `/instances/${iso.open.id}`)).toEqual(before);
  });
});
