import { DEFAULT_CLIENT_SETTINGS as DEFAULT_SETTINGS } from '@canopy/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantTx } from '../src/database.js';
import * as r from '../src/repositories/index.js';
import { systemContext, type TenantContext } from '../src/tenant-context.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { populateFirm, type PopulatedFirm } from './support/populate.js';

/** Reads for M10's Postgres adapter, M6's person reach and M5's range and unit count, across two firms. */

let t: TestDatabase;
let a: PopulatedFirm;
let b: PopulatedFirm;

beforeAll(async () => {
  t = await createTestDatabase();
  a = await populateFirm(t.db, await t.admin.createFirm({ name: 'Demo Advisory' }), 'a');
  b = await populateFirm(t.db, await t.admin.createFirm({ name: 'Second Ledger Consulting' }), 'b');
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

const inFirm = <T>(firm: PopulatedFirm, fn: (tx: TenantTx) => Promise<T>) =>
  t.db.withTenant(systemContext(firm.firmId, 'reads-test'), fn);
const asClient0 = (firm: PopulatedFirm): TenantContext => ({
  firmId: firm.firmId,
  personId: null,
  clientIds: [firm.clientIds[0]],
  requestId: 'reads-test',
});
const row = (
  firm: PopulatedFirm,
  table: string,
  scope: 'client0' | 'client1' | 'firmLevel',
  n = 0,
) => firm.rows[table]![scope][n]!;

describe('register multi-value filters', () => {
  it('filters by lists of departments, Acts and categories; an empty list matches nothing', async () => {
    const clientId = a.clientIds[0];
    const all = await inFirm(a, (tx) => r.instances.register(tx, clientId));
    expect(all.items).toHaveLength(1);
    const [only] = all.items;
    const by = (filter: r.RegisterFilter) =>
      inFirm(a, async (tx) => (await r.instances.register(tx, clientId, filter)).items.length);
    expect(await by({ departmentIds: [only!.departmentId, row(a, 'department', 'client1')] })).toBe(
      1,
    );
    expect(await by({ actIds: [only!.actId] })).toBe(1);
    expect(await by({ categoryIds: [row(a, 'category', 'firmLevel')] })).toBe(1);
    expect(await by({ unitIds: [only!.unitId], domain: ['HRS'] })).toBe(1);
    expect(await by({ departmentIds: [] })).toBe(0);
    expect(await by({ actIds: [row(b, 'act', 'firmLevel')] })).toBe(0);
    expect(await by({ categoryIds: [] })).toBe(0);
  });
});

describe('instance export details', () => {
  it('returns the obligation text, NA reason and first comment of visible instances only', async () => {
    const ids = [
      row(a, 'compliance_instance', 'client0'),
      row(a, 'compliance_instance', 'client1'),
    ];
    // Distinct comments per instance: client0 keeps 'Filed.' with a later one after it; client1's
    // 'Filed.' is archived, so its first live comment is the new one.
    await inFirm(a, async (tx) => {
      for (const [instanceId, clientId, body] of [
        [ids[0]!, a.clientIds[0], 'Later note on client 0.'],
        [ids[1]!, a.clientIds[1], 'Client 1 note.'],
      ] as const) {
        await r.comments.create(tx, { instanceId, clientId, authorId: null, kind: 'NOTE', body });
      }
    });
    await t.ownerQuery(
      `UPDATE comment SET archived_at = now() WHERE instance_id = $1 AND body = 'Filed.'`,
      [ids[1]],
    );
    const details = await inFirm(a, (tx) => r.instances.exportDetails(tx, ids));
    const first = { [ids[0]!]: 'Filed.', [ids[1]!]: 'Client 1 note.' };
    expect(details).toEqual(
      [...ids].sort().map((instanceId) => ({
        instanceId,
        description: 'File the annual return.',
        applicabilityText: null,
        naReason: null,
        firstComment: first[instanceId],
      })),
    );
    expect(
      await t.db.withTenant(asClient0(a), (tx) => r.instances.exportDetails(tx, ids)),
    ).toHaveLength(1);
    expect(await inFirm(b, (tx) => r.instances.exportDetails(tx, ids))).toEqual([]);
    expect(await inFirm(a, (tx) => r.instances.exportDetails(tx, []))).toEqual([]);
  });
});

describe('latest audit time per client', () => {
  it('lists the clients this context sees that have audit events', async () => {
    const latest = await inFirm(a, (tx) => r.auditEvents.latestByClient(tx));
    expect(latest.map((x) => x.clientId)).toEqual([...a.clientIds].sort());
    for (const x of latest) expect(Date.parse(x.at)).not.toBeNaN();
    const client0 = await t.db.withTenant(asClient0(a), (tx) => r.auditEvents.latestByClient(tx));
    expect(client0.map((x) => x.clientId)).toEqual([a.clientIds[0]]);
    const other = await inFirm(b, (tx) => r.auditEvents.latestByClient(tx));
    expect(other.map((x) => x.clientId).sort()).toEqual([...b.clientIds].sort());
  });
});

describe('units', () => {
  it('reads a unit with its company name and location label, in its firm only', async () => {
    const unitId = row(a, 'unit', 'client0');
    expect(await inFirm(a, (tx) => r.units.withLabels(tx, unitId))).toMatchObject({
      unit: { id: unitId, name: 'Plant' },
      companyName: 'Kestrel Aluminium',
      locationLabel: 'India / West Bengal / Riverbend a',
    });
    expect(await inFirm(b, (tx) => r.units.withLabels(tx, unitId))).toBeNull();
    expect(
      await t.db.withTenant(asClient0(a), (tx) =>
        r.units.withLabels(tx, row(a, 'unit', 'client1')),
      ),
    ).toBeNull();
  });

  it('counts the units a person may see', async () => {
    const clientId = a.clientIds[0];
    const unitId = row(a, 'unit', 'client0');
    expect(await inFirm(a, (tx) => r.units.count(tx, clientId, null))).toBe(1);
    expect(await inFirm(a, (tx) => r.units.count(tx, clientId, [unitId]))).toBe(1);
    expect(await inFirm(a, (tx) => r.units.count(tx, clientId, []))).toBe(0);
    expect(await inFirm(a, (tx) => r.units.count(tx, clientId, [row(a, 'unit', 'client1')]))).toBe(
      0,
    );
    expect(await inFirm(b, (tx) => r.units.count(tx, clientId, null))).toBe(0);
  });
});

describe('generated range', () => {
  it("spans the client's instance due dates, or is null", async () => {
    expect(await inFirm(a, (tx) => r.clients.generatedRange(tx, a.clientIds[0]))).toEqual({
      from: '2023-01-31',
      to: '2023-01-31',
    });
    expect(await inFirm(b, (tx) => r.clients.generatedRange(tx, a.clientIds[0]))).toBeNull();
    const empty = await inFirm(a, (tx) =>
      r.clients.create(tx, { name: 'Empty group', settings: { ...DEFAULT_SETTINGS } }),
    );
    expect(await inFirm(a, (tx) => r.clients.generatedRange(tx, empty.id))).toBeNull();
  });
});

describe('person reach', () => {
  it('returns the clients a person works in and whether they are firm staff', async () => {
    const [ownerId, , adminId] = a.rows.person!.firmLevel as [string, string, string];
    expect(await inFirm(a, (tx) => r.people.reach(tx, ownerId))).toEqual({
      clientIds: [...a.clientIds].sort(),
      firmStaff: false,
    });
    expect(await inFirm(a, (tx) => r.people.reach(tx, adminId))).toEqual({
      clientIds: [],
      firmStaff: true,
    });
    // Ids only, including clients the caller cannot see; that is what M6 decides with.
    expect(await t.db.withTenant(asClient0(a), (tx) => r.people.reach(tx, ownerId))).toEqual({
      clientIds: [...a.clientIds].sort(),
      firmStaff: false,
    });
  });

  it('returns nothing for a person of another firm', async () => {
    const [ownerId, , adminId] = a.rows.person!.firmLevel as [string, string, string];
    for (const id of [ownerId, adminId]) {
      expect(await inFirm(b, (tx) => r.people.reach(tx, id))).toEqual({
        clientIds: [],
        firmStaff: false,
      });
    }
  });

  it('runs only for the app role', async () => {
    const { rows } = await t.ownerQuery<{ app: boolean; public: boolean }>(`
      SELECT has_function_privilege('canopy_app', 'app_person_reach(uuid)', 'EXECUTE') AS app,
             EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
                     WHERE p.proname = 'app_person_reach' AND x.grantee = 0) AS public`);
    expect(rows).toEqual([{ app: true, public: false }]);
  });
});
