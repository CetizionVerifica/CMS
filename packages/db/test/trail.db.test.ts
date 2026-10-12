import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSavepoint, type TenantTx } from '../src/database.js';
import { DbError } from '../src/errors.js';
import * as r from '../src/repositories/index.js';
import * as s from '../src/schema/index.js';
import { systemContext, type TenantContext } from '../src/tenant-context.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { populateFirm, type PopulatedFirm } from './support/populate.js';

/** M7's audit trail query, evidence vault and savepoints, across two firms. */

let t: TestDatabase;
let a: PopulatedFirm;
let b: PopulatedFirm;
let personId: string;
let instanceId: string;
let otherInstanceId: string;

beforeAll(async () => {
  t = await createTestDatabase();
  a = await populateFirm(t.db, await t.admin.createFirm({ name: 'Demo Advisory' }), 'a');
  b = await populateFirm(t.db, await t.admin.createFirm({ name: 'Second Ledger Consulting' }), 'b');
  personId = a.rows['person']!.firmLevel[0]!;
  instanceId = a.rows['compliance_instance']!.client0[0]!;
  otherInstanceId = a.rows['compliance_instance']!.client1[0]!;
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

const inFirm = <T>(firm: PopulatedFirm, fn: (tx: TenantTx) => Promise<T>) =>
  t.db.withTenant(systemContext(firm.firmId, 'trail-test'), fn);
const asClient1 = (): TenantContext => ({
  firmId: a.firmId,
  personId: null,
  clientIds: [a.clientIds[1]],
  requestId: 'trail-test',
});
const code = (e: unknown) => (e instanceof DbError ? e.code : String(e));

/** All pages of a cursor query. */
async function allPages<T>(
  page: (after: string | null) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<T[][]> {
  const pages: T[][] = [];
  let after: string | null = null;
  do {
    const p = await page(after);
    pages.push(p.items);
    after = p.nextCursor;
  } while (after);
  return pages;
}

describe('auditEvents.query', () => {
  beforeAll(async () => {
    // Five events in one transaction share `at`, so the id breaks the tie; two more later.
    const event = (action: 'UPDATE' | 'TRANSITION', entityId: string) => ({
      clientId: a.clientIds[0],
      requestId: 'trail-test',
      actorId: personId,
      actorKind: 'PERSON' as const,
      action,
      entityType: 'instance' as const,
      entityId,
      before: null,
      after: null,
      reason: null,
    });
    await inFirm(a, async (tx) => {
      for (let i = 0; i < 5; i++) await r.auditEvents.append(tx, event('UPDATE', instanceId));
    });
    for (let i = 0; i < 2; i++) {
      await inFirm(a, (tx) => r.auditEvents.append(tx, event('TRANSITION', instanceId)));
    }
  });

  it('pages newest first with a keyset cursor and no row lost or repeated', async () => {
    const pages = await allPages((after) =>
      inFirm(a, (tx) =>
        r.auditEvents.query(tx, { entityType: 'instance', entityId: instanceId, after, limit: 2 }),
      ),
    );
    const rows = pages.flat();
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((x) => x.id)).size).toBe(7);
    const sorted = [...rows].sort((x, y) =>
      x.at === y.at ? (x.id < y.id ? 1 : -1) : x.at < y.at ? 1 : -1,
    );
    expect(rows).toEqual(sorted);
    expect(rows.slice(0, 2).map((x) => x.action)).toEqual(['TRANSITION', 'TRANSITION']);
    expect(pages.map((p) => p.length)).toEqual([2, 2, 2, 1]);
  });

  it('filters by client, actor, action list and a half-open time range', async () => {
    const q = (query: r.AuditQuery) =>
      inFirm(a, async (tx) => (await r.auditEvents.query(tx, query)).items);
    expect(
      await q({ entityId: instanceId, action: ['TRANSITION'], actorId: personId }),
    ).toHaveLength(2);
    expect(await q({ action: [] })).toEqual([]);
    expect(await q({ clientId: a.clientIds[1], entityId: instanceId })).toEqual([]);
    expect(await q({ clientId: a.clientIds[0], entityId: instanceId, limit: 200 })).toHaveLength(7);
    const [newest] = await q({ entityId: instanceId, action: ['TRANSITION'], limit: 1 });
    expect(await q({ entityId: instanceId, action: ['TRANSITION'], from: newest!.at })).toEqual([
      newest,
    ]);
    expect(
      (await q({ entityId: instanceId, action: ['TRANSITION'], to: newest!.at })).map((x) => x.id),
    ).not.toContain(newest!.id);
  });

  it('sees only its own firm and the clients of its context', async () => {
    expect(
      (await inFirm(b, (tx) => r.auditEvents.query(tx, { entityId: instanceId }))).items,
    ).toEqual([]);
    const client1 = await t.db.withTenant(asClient1(), (tx) =>
      r.auditEvents.query(tx, { limit: 200 }),
    );
    expect(client1.items.every((x) => x.clientId === a.clientIds[1])).toBe(true);
  });

  it('refuses a malformed cursor or filter', async () => {
    await expect(inFirm(a, (tx) => r.auditEvents.query(tx, { after: 'nope' }))).rejects.toSatisfy(
      (e) => code(e) === 'VALIDATION',
    );
    await expect(
      inFirm(a, (tx) => r.auditEvents.query(tx, { from: '12 Oct 2026' })),
    ).rejects.toSatisfy((e) => code(e) === 'VALIDATION');
  });
});

describe('evidence.vault', () => {
  let labels: { unitId: string; actId: string; departmentId: string };

  beforeAll(async () => {
    const files = ['wages-apr.pdf', 'wages-may.pdf', 'Form-B.xlsx'];
    for (const fileName of files) {
      await inFirm(a, (tx) =>
        r.evidence.create(tx, {
          instanceId,
          clientId: a.clientIds[0],
          fileName,
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          sha256: 'c'.repeat(64),
          storageKey: `evidence/${instanceId}/${fileName}`,
          uploadedById: personId,
        }),
      );
    }
    const archived = await inFirm(a, (tx) =>
      r.evidence.create(tx, {
        instanceId,
        clientId: a.clientIds[0],
        fileName: 'wages-old.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        sha256: 'd'.repeat(64),
        storageKey: `evidence/${instanceId}/wages-old.pdf`,
        uploadedById: personId,
      }),
    );
    await inFirm(a, (tx) => r.evidence.archive(tx, archived.id));
    labels = await inFirm(a, async (tx) => {
      const [row] = await tx
        .select({
          unitId: s.complianceInstance.unitId,
          actId: s.obligation.actId,
          departmentId: s.assignment.departmentId,
        })
        .from(s.complianceInstance)
        .innerJoin(s.assignment, eq(s.assignment.id, s.complianceInstance.assignmentId))
        .innerJoin(s.obligation, eq(s.obligation.id, s.assignment.obligationId))
        .where(eq(s.complianceInstance.id, instanceId));
      return { ...row!, actId: row!.actId! };
    });
  });

  const vault = (filter: r.EvidenceVaultFilter = {}, clientId = a.clientIds[0]) =>
    inFirm(a, (tx) => r.evidence.vault(tx, clientId, filter));

  it('lists the client evidence newest first, without archived rows or storage keys', async () => {
    const pages = await allPages((after) => vault({ after, limit: 2 }));
    const rows = pages.flat();
    expect(rows.map((x) => x.fileName)).toEqual([
      'Form-B.xlsx',
      'wages-may.pdf',
      'wages-apr.pdf',
      'return.pdf',
    ]);
    expect(rows.every((x) => !('storageKey' in x))).toBe(true);
    expect(rows.every((x) => x.clientId === a.clientIds[0])).toBe(true);
  });

  it('filters by unit, Act, department, scan status, file name and upload time', async () => {
    const names = async (filter: r.EvidenceVaultFilter) =>
      (await vault(filter)).items.map((x) => x.fileName);
    expect(await names({ unitIds: [labels.unitId], actIds: [labels.actId] })).toHaveLength(4);
    expect(await names({ departmentIds: [labels.departmentId], q: 'WAGES' })).toEqual([
      'wages-may.pdf',
      'wages-apr.pdf',
    ]);
    expect(await names({ unitIds: [] })).toEqual([]);
    expect(await names({ actIds: [a.rows['act']!.firmLevel.at(-1)!], q: 'form' })).toSatisfy(
      (x: string[]) => x.length === 0 || x.every((n) => n === 'Form-B.xlsx'),
    );
    expect(await names({ scanStatus: ['INFECTED'] })).toEqual([]);
    expect(await names({ scanStatus: [] })).toEqual([]);
    expect((await names({ scanStatus: ['PENDING', 'CLEAN'] })).length).toBe(4);
    expect(await names({ q: '%' })).toEqual([]);
    const [newest] = (await vault({ limit: 1 })).items;
    expect(await names({ uploadedFrom: newest!.createdAt })).toEqual(['Form-B.xlsx']);
    expect(await names({ uploadedTo: newest!.createdAt })).not.toContain('Form-B.xlsx');
  });

  it("does not reach another firm's or another client's evidence", async () => {
    expect((await inFirm(b, (tx) => r.evidence.vault(tx, a.clientIds[0]))).items).toEqual([]);
    const fromClient1 = await t.db.withTenant(asClient1(), (tx) =>
      r.evidence.vault(tx, a.clientIds[0]),
    );
    expect(fromClient1.items).toEqual([]);
    const own = await vault({}, a.clientIds[1]);
    expect(own.items.map((x) => x.instanceId)).toEqual([otherInstanceId]);
  });

  it('refuses a malformed filter', async () => {
    await expect(vault({ uploadedFrom: '2026-10-12' })).rejects.toSatisfy(
      (e) => code(e) === 'VALIDATION',
    );
    await expect(vault({ limit: 0 })).rejects.toSatisfy((e) => code(e) === 'VALIDATION');
  });
});

describe('withSavepoint', () => {
  it('rolls back only the failed savepoint, keeps the tenant context, and the outer transaction commits', async () => {
    const marker = (n: number) => ({
      clientId: a.clientIds[0],
      requestId: `savepoint-${n}`,
      actorId: null,
      actorKind: 'SYSTEM' as const,
      action: 'TRANSITION' as const,
      entityType: 'instance' as const,
      entityId: otherInstanceId,
      before: null,
      after: null,
      reason: null,
    });
    const outcome = await inFirm(a, async (tx) => {
      const failed = await withSavepoint(tx, async (sp) => {
        await r.auditEvents.append(sp, marker(1));
        throw new Error('item failed');
      }).catch((e: Error) => e.message);
      const firms = await withSavepoint(tx, async (sp) => {
        await r.auditEvents.append(sp, marker(2));
        const { rows } = await sp.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM firm`);
        return rows[0]!.n;
      });
      await r.auditEvents.append(tx, marker(3));
      return { failed, firms };
    });
    expect(outcome).toEqual({ failed: 'item failed', firms: 1 });
    const kept = await inFirm(a, async (tx) =>
      (await r.auditEvents.query(tx, { entityId: otherInstanceId, limit: 200 })).items
        .map((x) => x.requestId)
        .filter((x) => x.startsWith('savepoint-'))
        .sort(),
    );
    expect(kept).toEqual(['savepoint-2', 'savepoint-3']);
  });
});
