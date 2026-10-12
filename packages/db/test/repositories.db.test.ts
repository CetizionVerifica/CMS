import { DEFAULT_CLIENT_SETTINGS, DEFAULT_FIRM_SETTINGS } from '@canopy/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantTx } from '../src/database.js';
import { DbError } from '../src/errors.js';
import * as r from '../src/repositories/index.js';
import { systemContext, type TenantContext } from '../src/tenant-context.js';
import { uuidv7 } from '../src/uuid.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';

/** Repository behaviour against Postgres: contract shapes out, versioning, idempotency, tenancy. */

let t: TestDatabase;
let firmA: string;
let firmB: string;

interface World {
  clientId: string;
  companyId: string;
  unitId: string;
  locationId: string;
  departmentId: string;
  ownerId: string;
  approverId: string;
  actId: string;
  categoryId: string;
  obligationId: string;
  assignmentId: string;
}
let world: World;

const ctxA = (): TenantContext => systemContext(firmA, 'repo-test');
const inA = <T>(fn: (tx: TenantTx) => Promise<T>) => t.db.withTenant(ctxA(), fn);
const inB = <T>(fn: (tx: TenantTx) => Promise<T>) =>
  t.db.withTenant(systemContext(firmB, 'repo-test'), fn);

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    return e instanceof DbError ? e.code : `not a DbError: ${String(e)}`;
  }
  return 'resolved';
}

beforeAll(async () => {
  t = await createTestDatabase();
  firmA = await t.admin.createFirm({ name: 'Demo Advisory' });
  firmB = await t.admin.createFirm({ name: 'Second Ledger Consulting' });
  world = await inA(async (tx) => {
    const client = await r.clients.create(tx, {
      name: 'Kestrel Metals Group',
      settings: DEFAULT_CLIENT_SETTINGS,
    });
    const company = await r.companies.create(tx, {
      clientId: client.id,
      name: 'Kestrel Aluminium',
    });
    const location = await r.locations.create(tx, {
      country: 'India',
      countryCode: 'IN',
      state: 'West Bengal',
      stateCode: 'WB',
      city: 'Riverbend',
    });
    const unit = await r.units.create(tx, {
      clientId: client.id,
      companyId: company.id,
      name: 'Plant',
      locationId: location.id,
    });
    const department = await r.departments.create(tx, {
      clientId: client.id,
      name: 'Human Resources',
      aliases: ['HR'],
    });
    const owner = await r.people.create(tx, {
      displayName: 'Owner 01',
      nameNormalized: 'owner 01',
      email: null,
      status: 'UNCLAIMED',
    });
    const approver = await r.people.create(tx, {
      displayName: 'Approver 01',
      nameNormalized: 'approver 01',
      email: 'approver01@example.com',
      status: 'ACTIVE',
    });
    const act = await r.acts.create(tx, {
      name: 'Income Tax Act, 1961',
      shortName: null,
      jurisdiction: 'CENTRAL',
      stateCode: null,
      aliases: ['Income-tax Act 1961'],
    });
    const category = await r.categories.create(tx, { name: 'Payments', aliases: [] });
    const obligation = await r.obligations.create(tx, {
      externalRef: 'TAX-CL-033-6067-60218',
      domain: 'TAX',
      jurisdiction: 'CENTRAL',
      stateCode: null,
      actId: act.id,
      categoryId: category.id,
      title: 'Deposit TDS',
      description: 'Deposit tax deducted at source.\nBy the 7th.',
      applicabilityText: null,
      criticality: 'HIGH',
      timelineType: 'TIME_BASED',
      recurrenceRule: { kind: 'MONTHLY', day: 7, offsetMonths: 1 },
      ruleStatus: 'CONFIRMED',
      evidenceRequired: false,
      forms: [{ label: 'Challan 281', fileName: null, templateFileId: null }],
      logSheets: [],
      libraryVersion: 1,
    });
    const assignment = await r.assignments.create(tx, {
      clientId: client.id,
      unitId: unit.id,
      obligationId: obligation.id,
      departmentId: department.id,
      defaultOwnerId: owner.id,
      defaultApproverId: approver.id,
      applicability: 'APPLICABLE',
      naReason: null,
      activeFrom: '2022-04-01' as never,
      activeTo: null,
    });
    return {
      clientId: client.id,
      companyId: company.id,
      unitId: unit.id,
      locationId: location.id,
      departmentId: department.id,
      ownerId: owner.id,
      approverId: approver.id,
      actId: act.id,
      categoryId: category.id,
      obligationId: obligation.id,
      assignmentId: assignment.id,
    };
  });
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

function period(month: string, due: string) {
  return {
    clientId: world.clientId,
    unitId: world.unitId,
    assignmentId: world.assignmentId,
    periodStart: `2022-${month}-01`,
    periodEnd: `2022-${month}-28`,
    dueDate: due,
    workflowState: 'OPEN',
    pendingKind: null,
    completedOn: null,
    naReason: null,
    ownerId: world.ownerId,
    approverId: world.approverId,
    submittedAt: null,
    approvedAt: null,
    dueDateOverridden: false,
  } as unknown as Parameters<typeof r.instances.create>[1];
}

describe('tenancy and people', () => {
  it('returns contract shapes with ISO instants', async () => {
    const client = await inA((tx) => r.clients.require(tx, world.clientId));
    expect(client.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(client.version).toBe(1);
    expect(client.settings).toEqual(DEFAULT_CLIENT_SETTINGS);
    const firm = await inA((tx) => r.firms.current(tx));
    expect(firm).toMatchObject({ id: firmA, settings: DEFAULT_FIRM_SETTINGS });
  });

  it('updates with optimistic concurrency', async () => {
    const updated = await inA((tx) =>
      r.companies.update(tx, world.companyId, 1, { name: 'Kestrel Aluminium Industries' }),
    );
    expect(updated).toMatchObject({ name: 'Kestrel Aluminium Industries', version: 2 });
    expect(
      await code(inA((tx) => r.companies.update(tx, world.companyId, 1, { name: 'Stale' }))),
    ).toBe('STALE_VERSION');
    const firm = await inA((tx) => r.firms.current(tx));
    const renamed = await inA((tx) =>
      r.firms.update(tx, firm.version, { name: 'Demo Advisory LLP' }),
    );
    expect(renamed.version).toBe(firm.version + 1);
  });

  it('archives and restores, and archived rows leave lists', async () => {
    const extra = await inA((tx) =>
      r.companies.create(tx, { clientId: world.clientId, name: 'Kestrel Fibres' }),
    );
    const archived = await inA((tx) => r.companies.archive(tx, extra.id, 1));
    expect(archived.archivedAt).not.toBeNull();
    const names = async (includeArchived: boolean) =>
      (await inA((tx) => r.companies.list(tx, world.clientId, { includeArchived }))).items.map(
        (c) => c.name,
      );
    expect(await names(false)).not.toContain('Kestrel Fibres');
    expect(await names(true)).toContain('Kestrel Fibres');
    expect(await code(inA((tx) => r.companies.update(tx, extra.id, 2, { name: 'x' })))).toBe(
      'NOT_FOUND',
    );
    const restored = await inA((tx) => r.companies.restore(tx, extra.id, 2));
    expect(restored).toMatchObject({ archivedAt: null, version: 3 });
    expect(await code(inA((tx) => r.companies.restore(tx, extra.id, 3)))).toBe('NOT_FOUND');
  });

  it('pages lists with an opaque cursor', async () => {
    await inA(async (tx) => {
      for (const name of ['A', 'B', 'C'])
        await r.categories.create(tx, { name: `Page ${name}`, aliases: [] });
    });
    const first = await inA((tx) => r.categories.list(tx, { limit: 2 }));
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const rest = await inA((tx) => r.categories.list(tx, { limit: 200, cursor: first.nextCursor }));
    const all = [...first.items, ...rest.items].map((c) => c.id);
    expect(new Set(all).size).toBe(all.length);
    expect(rest.nextCursor).toBeNull();
    expect(await code(inA((tx) => r.categories.list(tx, { limit: 201 })))).toBe('VALIDATION');
    expect(await code(inA((tx) => r.categories.list(tx, { cursor: 'bad' })))).toBe('VALIDATION');
  });

  it('finds by alias, path, normalised name and email', async () => {
    await inA(async (tx) => {
      expect((await r.departments.findByNameOrAlias(tx, world.clientId, 'HR'))?.id).toBe(
        world.departmentId,
      );
      expect((await r.acts.findByNameOrAlias(tx, 'Income-tax Act 1961'))?.id).toBe(world.actId);
      expect(await r.categories.findByNameOrAlias(tx, 'Nope')).toBeNull();
      expect((await r.categories.findByNameOrAlias(tx, 'Payments'))?.id).toBe(world.categoryId);
      expect(
        (
          await r.locations.findByPath(tx, {
            countryCode: 'IN',
            state: 'west bengal',
            city: 'RIVERBEND',
          })
        )?.id,
      ).toBe(world.locationId);
      expect((await r.people.findByNormalizedName(tx, 'owner 01')).map((p) => p.id)).toEqual([
        world.ownerId,
      ]);
      expect((await r.people.findByEmail(tx, 'APPROVER01@example.com'))?.id).toBe(world.approverId);
      expect(
        (await r.companies.findByName(tx, world.clientId, 'Kestrel Aluminium Industries'))?.id,
      ).toBe(world.companyId);
      expect((await r.units.findByName(tx, world.companyId, 'Plant'))?.id).toBe(world.unitId);
      expect((await r.obligations.findByExternalRef(tx, 'TAX-CL-033-6067-60218')).length).toBe(1);
      expect(
        (
          await r.assignments.findByKey(tx, {
            unitId: world.unitId,
            obligationId: world.obligationId,
            departmentId: world.departmentId,
          })
        )?.id,
      ).toBe(world.assignmentId);
      expect((await r.assignments.forObligation(tx, world.obligationId)).length).toBe(1);
    });
  });

  it('maps unique, check and contract violations to error codes', async () => {
    expect(
      await code(
        inA((tx) =>
          r.departments.create(tx, {
            clientId: world.clientId,
            name: 'Human Resources',
            aliases: [],
          }),
        ),
      ),
    ).toBe('DUPLICATE');
    // An UNCLAIMED person has no email: a CHECK constraint and the contract both say so.
    expect(
      await code(
        inA((tx) =>
          r.people.create(tx, {
            displayName: 'X',
            nameNormalized: 'x',
            email: 'x@example.com',
            status: 'UNCLAIMED',
          }),
        ),
      ),
    ).toBe('VALIDATION');
    // Only the contract knows a MONTHLY day must be 1-31: the write is rolled back.
    expect(
      await code(
        inA(async (tx) => {
          const o = await r.obligations.require(tx, world.obligationId);
          return r.obligations.update(tx, o.id, o.version, {
            recurrenceRule: { kind: 'MONTHLY', day: 40, offsetMonths: 1 } as never,
          });
        }),
      ),
    ).toBe('VALIDATION');
    expect(
      (await inA((tx) => r.obligations.require(tx, world.obligationId))).recurrenceRule,
    ).toEqual({
      kind: 'MONTHLY',
      day: 7,
      offsetMonths: 1,
    });
  });

  it('memberships: a person sees their own; VIEWER expiry round-trips as an instant', async () => {
    const m = await inA((tx) =>
      r.memberships.create(tx, {
        personId: world.approverId,
        role: 'VIEWER',
        clientId: world.clientId,
        consultantClientIds: null,
        unitIds: null,
        expiresAt: '2027-03-31T18:30:00.000Z',
      }),
    );
    expect(m.expiresAt).toBe('2027-03-31T18:30:00.000Z');
    const own = await t.db.withTenant(
      { firmId: firmA, personId: world.approverId, clientIds: [], requestId: 'me' },
      (tx) => r.memberships.forPerson(tx, world.approverId),
    );
    expect(own.map((x) => x.id)).toEqual([m.id]);
    expect(
      (await inA((tx) => r.memberships.list(tx, world.clientId))).items.map((x) => x.id),
    ).toContain(m.id);
  });
  it('people: a client admin creates a person with their membership, but not alone', async () => {
    const clientAdmin: TenantContext = {
      firmId: firmA,
      personId: null,
      clientIds: [world.clientId],
      requestId: 'client-admin',
    };
    const person = {
      displayName: 'New Owner',
      nameNormalized: 'new owner',
      email: null,
      status: 'UNCLAIMED',
    } as const;
    // The new row is not visible to the client context until a membership exists.
    expect(await code(t.db.withTenant(clientAdmin, (tx) => r.people.create(tx, person)))).not.toBe(
      'resolved',
    );
    const created = await t.db.withTenant(clientAdmin, (tx) =>
      r.people.createWithMembership(tx, person, {
        role: 'OWNER',
        clientId: world.clientId,
        consultantClientIds: null,
        unitIds: [world.unitId],
        expiresAt: null,
      }),
    );
    expect(created.person).toMatchObject({ displayName: 'New Owner', firmId: firmA, version: 1 });
    expect(created.membership.personId).toBe(created.person.id);
    // A client the context cannot see is refused, and nothing is left behind.
    const other = await inA((tx) =>
      r.clients.create(tx, { name: 'Hidden Group', settings: DEFAULT_CLIENT_SETTINGS }),
    );
    expect(
      await code(
        t.db.withTenant(clientAdmin, (tx) =>
          r.people.createWithMembership(
            tx,
            { ...person, nameNormalized: 'hidden owner', displayName: 'Hidden Owner' },
            {
              role: 'OWNER',
              clientId: other.id,
              consultantClientIds: null,
              unitIds: null,
              expiresAt: null,
            },
          ),
        ),
      ),
    ).toBe('FORBIDDEN');
    expect(await inA((tx) => r.people.findByNormalizedName(tx, 'hidden owner'))).toEqual([]);
  });
  it('an update RLS refuses at the current version is FORBIDDEN, not STALE_VERSION', async () => {
    const clientUser: TenantContext = {
      firmId: firmA,
      personId: null,
      clientIds: [world.clientId],
      requestId: 'client-user',
    };
    const firm = await inA((tx) => r.firms.current(tx));
    expect(
      await code(
        t.db.withTenant(clientUser, (tx) =>
          r.firms.update(tx, firm.version, { name: 'Taken Over' }),
        ),
      ),
    ).toBe('FORBIDDEN');
    // A person who also works for a client this context cannot see.
    const other = await inA((tx) =>
      r.clients.create(tx, { name: 'Shared Staff Group', settings: DEFAULT_CLIENT_SETTINGS }),
    );
    const shared = await inA(async (tx) => {
      const { person } = await r.people.createWithMembership(
        tx,
        {
          displayName: 'Shared Person',
          nameNormalized: 'shared person',
          email: null,
          status: 'UNCLAIMED',
        },
        {
          role: 'OWNER',
          clientId: world.clientId,
          consultantClientIds: null,
          unitIds: [world.unitId],
          expiresAt: null,
        },
      );
      await r.memberships.create(tx, {
        personId: person.id,
        role: 'APPROVER',
        clientId: other.id,
        consultantClientIds: null,
        unitIds: null,
        expiresAt: null,
      });
      return person;
    });
    expect(
      await code(
        t.db.withTenant(clientUser, (tx) =>
          r.people.update(tx, shared.id, shared.version, { displayName: 'Renamed' }),
        ),
      ),
    ).toBe('FORBIDDEN');
    // A wrong version is still STALE_VERSION.
    expect(
      await code(
        t.db.withTenant(clientUser, (tx) => r.firms.update(tx, firm.version + 5, { name: 'X' })),
      ),
    ).toBe('STALE_VERSION');
  });

  it('a client context cannot reveal a hidden person by giving them a membership', async () => {
    const hiddenClient = await inA((tx) =>
      r.clients.create(tx, { name: 'Other Group', settings: DEFAULT_CLIENT_SETTINGS }),
    );
    const hidden = await inA(async (tx) => {
      const { person } = await r.people.createWithMembership(
        tx,
        {
          displayName: 'Hidden Person',
          nameNormalized: 'hidden person',
          email: 'hidden@example.com',
          status: 'INVITED',
        },
        {
          role: 'OWNER',
          clientId: hiddenClient.id,
          consultantClientIds: null,
          unitIds: null,
          expiresAt: null,
        },
      );
      return person;
    });
    const clientUser: TenantContext = {
      firmId: firmA,
      personId: null,
      clientIds: [world.clientId],
      requestId: 'client-user',
    };
    const link = (tx: TenantTx) =>
      r.memberships.create(tx, {
        personId: hidden.id,
        role: 'VIEWER',
        clientId: world.clientId,
        consultantClientIds: null,
        unitIds: null,
        expiresAt: '2027-03-31T18:30:00.000Z',
      });
    expect(await code(t.db.withTenant(clientUser, link))).toBe('NOT_FOUND');
    // Moving one of its own memberships onto the hidden person is refused the same way.
    const own = await t.db.withTenant(clientUser, (tx) => r.memberships.list(tx, world.clientId));
    const m = own.items[0]!;
    expect(
      await code(
        t.db.withTenant(clientUser, (tx) =>
          r.memberships.update(tx, m.id, m.version, { personId: hidden.id }),
        ),
      ),
    ).toBe('NOT_FOUND');
    expect(await t.db.withTenant(clientUser, (tx) => r.people.get(tx, hidden.id))).toBeNull();
  });

  it('update ignores server fields smuggled into a patch', async () => {
    const dept = await inA((tx) =>
      r.departments.create(tx, { clientId: world.clientId, name: 'Smuggle Test', aliases: [] }),
    );
    const updated = await inA((tx) =>
      r.departments.update(tx, dept.id, dept.version, {
        name: 'Smuggle Test 2',
        id: '01920000-0000-7000-8000-000000000bad',
        version: 99,
        firmId: firmB,
      } as never),
    );
    expect(updated).toMatchObject({
      id: dept.id,
      version: dept.version + 1,
      firmId: firmA,
      name: 'Smuggle Test 2',
    });
  });
});

describe('firm B', () => {
  it('cannot read or change firm A through any repository', async () => {
    await inB(async (tx) => {
      expect(await r.clients.get(tx, world.clientId)).toBeNull();
      expect(await r.obligations.get(tx, world.obligationId)).toBeNull();
      expect((await r.clients.list(tx)).items).toEqual([]);
      expect(await r.people.findByEmail(tx, 'approver01@example.com')).toBeNull();
    });
    expect(await code(inB((tx) => r.clients.require(tx, world.clientId)))).toBe('NOT_FOUND');
    expect(await code(inB((tx) => r.units.update(tx, world.unitId, 1, { name: 'Taken' })))).toBe(
      'NOT_FOUND',
    );
    // Pointing at firm A's unit from firm B fails on the composite foreign key.
    const own = await inB((tx) =>
      r.clients.create(tx, { name: 'Northwind Foods Group', settings: DEFAULT_CLIENT_SETTINGS }),
    );
    expect(
      await code(
        inB((tx) =>
          r.departments.create(tx, { clientId: world.clientId, name: 'HR', aliases: [] }),
        ),
      ),
    ).toBe('NOT_FOUND');
    expect(
      await code(
        inB((tx) =>
          r.companies.create(tx, { clientId: own.id, name: 'Northwind' }).then(() =>
            r.units.create(tx, {
              clientId: own.id,
              companyId: world.companyId,
              name: 'Pune',
              locationId: world.locationId,
            }),
          ),
        ),
      ),
    ).toBe('NOT_FOUND');
  });
});

describe('instances', () => {
  it('generation is idempotent on (assignment, periodStart)', async () => {
    const first = await inA((tx) =>
      r.instances.insertGenerated(tx, [period('05', '2022-06-07'), period('06', '2022-07-07')]),
    );
    expect(first).toHaveLength(2);
    const again = await inA((tx) =>
      r.instances.insertGenerated(tx, [
        period('05', '2022-06-07'),
        period('06', '2022-07-07'),
        period('07', '2022-08-07'),
      ]),
    );
    expect(again.map((i) => i.periodStart)).toEqual(['2022-07-01']);
    expect(await inA((tx) => r.instances.insertGenerated(tx, []))).toEqual([]);
    const all = await inA((tx) => r.instances.forAssignment(tx, world.assignmentId));
    expect(all.map((i) => i.dueDate)).toEqual(['2022-06-07', '2022-07-07', '2022-08-07']);
    expect((await inA((tx) => r.instances.list(tx, world.assignmentId))).items).toHaveLength(3);
  });

  it('updates a workflow state with the contract’s consistency rules', async () => {
    const [i] = await inA((tx) => r.instances.forAssignment(tx, world.assignmentId));
    const submitted = await inA((tx) =>
      r.instances.update(tx, i!.id, i!.version, {
        workflowState: 'SUBMITTED',
        pendingKind: 'COMPLETION',
        completedOn: '2022-06-06' as never,
        submittedAt: '2022-06-06T10:00:00.000Z',
      }),
    );
    expect(submitted).toMatchObject({
      workflowState: 'SUBMITTED',
      version: 2,
      submittedAt: '2022-06-06T10:00:00.000Z',
    });
    // SUBMITTED without pendingKind is refused.
    expect(await code(inA((tx) => r.instances.update(tx, i!.id, 2, { pendingKind: null })))).toBe(
      'VALIDATION',
    );
    expect((await inA((tx) => r.instances.require(tx, i!.id))).version).toBe(2);
  });

  it('serves the register with joins, filters and keyset pages', async () => {
    await inA(async (tx) => {
      const [first] = await r.instances.forAssignment(tx, world.assignmentId);
      await r.comments.create(tx, {
        instanceId: first!.id,
        clientId: world.clientId,
        authorId: world.ownerId,
        kind: 'SUBMIT',
        body: 'Challan uploaded',
      });
      await r.evidence.create(tx, {
        instanceId: first!.id,
        clientId: world.clientId,
        fileName: 'challan.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
        sha256: 'b'.repeat(64),
        storageKey: `evidence/${first!.id}/challan.pdf`,
        uploadedById: world.ownerId,
      });
    });
    const page1 = await inA((tx) => r.instances.register(tx, world.clientId, {}, { limit: 2 }));
    expect(page1.items.map((x) => x.dueDate)).toEqual(['2022-06-07', '2022-07-07']);
    expect(page1.items[0]).toMatchObject({
      externalRef: 'TAX-CL-033-6067-60218',
      actName: 'Income Tax Act, 1961',
      categoryName: 'Payments',
      companyName: 'Kestrel Aluminium Industries',
      unitName: 'Plant',
      locationLabel: 'India / West Bengal / Riverbend',
      departmentName: 'Human Resources',
      ownerName: 'Owner 01',
      approverName: 'Approver 01',
      evidenceCount: 1,
      commentCount: 1,
      lastComment: 'Challan uploaded',
      formLabels: ['Challan 281'],
      logSheetLabels: [],
    });
    expect(page1.items[0]).not.toHaveProperty('status');
    const page2 = await inA((tx) =>
      r.instances.register(tx, world.clientId, {}, { limit: 2, cursor: page1.nextCursor }),
    );
    expect(page2.items.map((x) => x.dueDate)).toEqual(['2022-08-07']);
    expect(page2.nextCursor).toBeNull();

    const filtered = async (f: r.RegisterFilter) =>
      (await inA((tx) => r.instances.register(tx, world.clientId, f))).items.map((x) => x.dueDate);
    expect(await filtered({ workflowState: ['SUBMITTED'] })).toEqual(['2022-06-07']);
    expect(
      await filtered({ dueFrom: '2022-07-01' as never, dueTo: '2022-07-31' as never }),
    ).toEqual(['2022-07-07']);
    expect(await filtered({ hasEvidence: true })).toEqual(['2022-06-07']);
    expect(await filtered({ hasEvidence: false })).toHaveLength(2);
    expect(await filtered({ q: 'challan' })).toEqual(['2022-06-07']);
    expect(await filtered({ q: 'tds' })).toHaveLength(3);
    expect(await filtered({ q: '100%' })).toEqual([]);
    expect(await filtered({ criticality: ['LOW'] })).toEqual([]);
    expect(await filtered({ unitIds: [] })).toEqual([]);
    expect(await filtered({ instanceIds: [] })).toEqual([]);
    expect(
      await filtered({
        unitId: world.unitId,
        unitIds: [world.unitId],
        departmentId: world.departmentId,
        actId: world.actId,
        categoryId: world.categoryId,
        ownerId: world.ownerId,
        approverId: world.approverId,
        timelineType: 'TIME_BASED',
        domain: ['TAX'],
        completedFrom: '2022-06-01' as never,
        completedTo: '2022-06-30' as never,
      }),
    ).toEqual(['2022-06-07']);
    expect(
      await code(inA((tx) => r.instances.register(tx, world.clientId, {}, { cursor: 'x' }))),
    ).toBe('VALIDATION');
    expect(await code(inA((tx) => r.instances.register(tx, world.clientId, { q: 'x' })))).toBe(
      'VALIDATION',
    );
  });

  it('evidence: views hide the storage key; scan status and archive', async () => {
    const [first] = await inA((tx) => r.instances.forAssignment(tx, world.assignmentId));
    const [view] = await inA((tx) => r.evidence.forInstance(tx, first!.id));
    expect(view).not.toHaveProperty('storageKey');
    expect((await inA((tx) => r.evidence.require(tx, view!.id))).storageKey).toContain(
      'challan.pdf',
    );
    expect((await inA((tx) => r.evidence.setScanStatus(tx, view!.id, 'CLEAN'))).scanStatus).toBe(
      'CLEAN',
    );
    expect(await inA((tx) => r.evidence.view(tx, view!.id))).toMatchObject({ scanStatus: 'CLEAN' });
    await inA((tx) => r.evidence.archive(tx, view!.id));
    expect(await inA((tx) => r.evidence.forInstance(tx, first!.id))).toEqual([]);
    expect(
      await inA((tx) => r.evidence.view(tx, '01920000-0000-7000-8000-000000000099')),
    ).toBeNull();
    expect(
      await code(
        inA((tx) => r.evidence.setScanStatus(tx, '01920000-0000-7000-8000-000000000099', 'CLEAN')),
      ),
    ).toBe('NOT_FOUND');
    const comments = await inA((tx) => r.comments.forInstance(tx, first!.id));
    expect(comments.map((c) => c.body)).toEqual(['Challan uploaded']);
    expect(await inA((tx) => r.comments.get(tx, comments[0]!.id))).toMatchObject({
      kind: 'SUBMIT',
    });
  });
});

describe('audit and outbox', () => {
  it('appends audit events and reads an entity’s history newest first', async () => {
    await inA(async (tx) => {
      for (const reason of ['first', 'second']) {
        await r.auditEvents.append(tx, {
          clientId: world.clientId,
          requestId: 'req-1',
          actorId: world.approverId,
          actorKind: 'PERSON',
          action: 'TRANSITION',
          entityType: 'assignment',
          entityId: world.assignmentId,
          before: { applicability: 'TO_ASSESS' },
          after: { applicability: 'APPLICABLE' },
          reason,
        });
      }
    });
    const history = await inA((tx) =>
      r.auditEvents.forEntity(tx, 'assignment', world.assignmentId),
    );
    expect(history.map((h) => h.reason)).toEqual(['second', 'first']);
    expect(history[0]!.firmId).toBe(firmA);
    await expect(
      inA((tx) =>
        r.auditEvents.append(tx, {
          clientId: null,
          requestId: 'req-1',
          actorId: null,
          actorKind: 'PERSON',
          action: 'LOGIN',
          entityType: 'person',
          entityId: world.ownerId,
          before: null,
          after: null,
          reason: null,
        }),
      ),
    ).rejects.toThrow(/actorId/);
  });

  it('enqueues, claims once and marks events published', async () => {
    await inA((tx) =>
      r.domainEvents.enqueue(tx, {
        type: 'assignment.created',
        clientId: world.clientId,
        actor: { kind: 'SYSTEM', job: 'test' },
        requestId: 'req-2',
        aggregate: { type: 'assignment', id: world.assignmentId },
        aggregateVersion: 1,
        data: { assignmentId: world.assignmentId },
      }),
    );
    const claimed = await inA(async (tx) => {
      const events = await r.domainEvents.claimUnpublished(tx, 10);
      await r.domainEvents.recordFailure(tx, events[0]!.id);
      await r.domainEvents.markPublished(
        tx,
        events.map((e) => e.id),
      );
      await r.domainEvents.markPublished(tx, []);
      return events;
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      type: 'assignment.created',
      firmId: firmA,
      schemaVersion: 1,
    });
    expect(await inA((tx) => r.domainEvents.claimUnpublished(tx))).toEqual([]);
    await expect(
      inA((tx) =>
        r.domainEvents.enqueue(tx, {
          type: 'Bad Type',
          clientId: null,
          actor: { kind: 'SYSTEM', job: 'x' },
          requestId: 'r',
          aggregate: { type: 'x', id: world.assignmentId },
          aggregateVersion: 1,
          data: {},
        }),
      ),
    ).rejects.toThrow();
  });

  it('claims a notification send once per instance, kind and date', async () => {
    const [first] = await inA((tx) => r.instances.forAssignment(tx, world.assignmentId));
    const send = {
      clientId: world.clientId,
      instanceId: first!.id,
      recipientId: world.ownerId,
      kind: 'OWNER_REMINDER' as const,
      sendDate: '2022-05-31' as never,
    };
    expect(await inA((tx) => r.notificationSends.claim(tx, send))).toBe('NEW');
    // Claimed but no outcome yet (a crashed run): send again.
    expect(await inA((tx) => r.notificationSends.claim(tx, send))).toBe('PENDING');
    // The same reminder for a different recipient (an owner reassigned that day) is its own send.
    const reassigned = { ...send, recipientId: world.approverId };
    expect(await inA((tx) => r.notificationSends.claim(tx, reassigned))).toBe('NEW');
    const digest = { ...send, instanceId: null, kind: 'CONSULTANT_DIGEST' as const };
    expect(await inA((tx) => r.notificationSends.claim(tx, digest))).toBe('NEW');
    expect(
      await inA((tx) => r.notificationSends.listDone(tx, world.clientId, '2022-05-31')),
    ).toEqual([]);
    const sendId = await inA((tx) =>
      r.notificationSends.markSent(tx, send, '2022-05-31T03:30:00.000Z'),
    );
    expect(sendId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await inA((tx) => r.notificationSends.listDoneDigests(tx, '2022-05-31'))).toEqual([]);
    await inA((tx) => r.notificationSends.markFailed(tx, digest, 'NO_EMAIL'));
    expect(await inA((tx) => r.notificationSends.claim(tx, send))).toBe('DONE');
    expect(await inA((tx) => r.notificationSends.listDoneDigests(tx, '2022-05-31'))).toEqual([
      world.ownerId,
    ]);
    // markSent needs a claimed row.
    expect(
      await code(
        inA((tx) =>
          r.notificationSends.markSent(
            tx,
            { ...send, sendDate: '2022-06-01' as never },
            '2022-06-01T03:30:00.000Z',
          ),
        ),
      ),
    ).toBe('NOT_FOUND');
    expect(await inA((tx) => r.notificationSends.claim(tx, digest))).toBe('DONE');
    expect(
      (await inA((tx) => r.notificationSends.listDone(tx, world.clientId, '2022-05-31'))).map(
        (k) => k.kind,
      ),
    ).toEqual(['OWNER_REMINDER', 'CONSULTANT_DIGEST']);
    expect(
      await code(inA((tx) => r.notificationSends.markFailed(tx, digest, 'SMTP_DOWN' as never))),
    ).toBe('VALIDATION');
    const { rows } = await t.ownerQuery<{
      kind: string;
      sent_at: Date | null;
      failure_code: string | null;
    }>('SELECT kind, sent_at, failure_code FROM notification_send ORDER BY kind, sent_at IS NULL');
    expect(rows).toEqual([
      { kind: 'OWNER_REMINDER', sent_at: new Date('2022-05-31T03:30:00.000Z'), failure_code: null },
      { kind: 'OWNER_REMINDER', sent_at: null, failure_code: null },
      { kind: 'CONSULTANT_DIGEST', sent_at: null, failure_code: 'NO_EMAIL' },
    ]);
  });

  it('keys an event-driven send on event and recipient, apart from the scheduled sends', async () => {
    const [first] = await inA((tx) => r.instances.forAssignment(tx, world.assignmentId));
    const eventId = '01920000-0000-7000-8000-00000000e001';
    const send = {
      clientId: world.clientId,
      instanceId: first!.id,
      recipientId: world.ownerId,
      kind: 'OWNER_REMINDER' as const,
      sendDate: '2022-07-01' as never,
      eventId,
    };
    const scheduled = { ...send, eventId: null };
    expect(await inA((tx) => r.notificationSends.claim(tx, send))).toBe('NEW');
    // The same instance, kind, date and recipient as a scheduled send is a separate row.
    expect(await inA((tx) => r.notificationSends.claim(tx, scheduled))).toBe('NEW');
    // The event reaches the recipient once, whatever the date; another recipient is its own send.
    const nextDay = { ...send, sendDate: '2022-07-02' as never };
    expect(await inA((tx) => r.notificationSends.claim(tx, nextDay))).toBe('PENDING');
    expect(
      await inA((tx) => r.notificationSends.claim(tx, { ...send, recipientId: world.approverId })),
    ).toBe('NEW');
    await inA((tx) => r.notificationSends.markSent(tx, send, '2022-07-01T04:00:00.000Z'));
    expect(await inA((tx) => r.notificationSends.claim(tx, nextDay))).toBe('DONE');
    expect(await inA((tx) => r.notificationSends.claim(tx, scheduled))).toBe('PENDING');
    // Date-keyed reads list scheduled sends only.
    expect(
      await inA((tx) => r.notificationSends.listDone(tx, world.clientId, '2022-07-01')),
    ).toEqual([]);
    await inA((tx) => r.notificationSends.markFailed(tx, scheduled, 'NOT_ACTIVE'));
    expect(
      await inA((tx) => r.notificationSends.listDone(tx, world.clientId, '2022-07-01')),
    ).toHaveLength(1);
    expect(await code(inA((tx) => r.notificationSends.claim(tx, { ...send, eventId: 'x' })))).toBe(
      'VALIDATION',
    );
  });

  it('export jobs keep the storage key out of the contract shape', async () => {
    const job = await inA((tx) =>
      r.exportJobs.create(tx, {
        clientId: world.clientId,
        kind: 'REGISTER_XLSX',
        params: { fy: '2022-23' },
        requestedById: world.approverId,
      }),
    );
    expect(job.status).toBe('QUEUED');
    const done = await inA((tx) =>
      r.exportJobs.setStatus(tx, job.id, {
        status: 'DONE',
        fileName: 'register.xlsx',
        storageKey: 'exports/1.xlsx',
      }),
    );
    expect(done).not.toHaveProperty('storageKey');
    expect(await inA((tx) => r.exportJobs.storageKey(tx, job.id))).toBe('exports/1.xlsx');
    expect(await inA((tx) => r.exportJobs.storageKey(tx, world.assignmentId))).toBeNull();
    expect((await inA((tx) => r.exportJobs.require(tx, job.id))).fileName).toBe('register.xlsx');
  });
});

describe('imports', () => {
  it('stores a batch with its rows and issues, and decides a group once', async () => {
    const template = await inA((tx) =>
      r.mappingTemplates.create(tx, {
        clientId: null,
        name: 'EY grid export',
        mapping: [{ sourceHeader: 'EY Compliance ID', field: 'externalRef' }],
      }),
    );
    const batch = await inA((tx) =>
      r.importBatches.create(tx, {
        clientId: world.clientId,
        createdById: world.approverId,
        fileName: 'register.xlsx',
        fileSha256: 'c'.repeat(64),
        sheetName: null,
        mapping: template.mapping,
        mappingTemplateId: template.id,
        counts: null,
        dryRun: null,
        committedAt: null,
        failureCode: null,
      }),
    );
    expect(batch.status).toBe('UPLOADED');
    const [issue] = await inA((tx) =>
      r.importIssues.createMany(tx, batch.id, [
        {
          batchId: batch.id,
          groupKey: 'ALIAS_DEPARTMENT:Human Resources',
          type: 'ALIAS_DEPARTMENT',
          severity: 'WARNING',
          rowNumbers: [2, 3],
          field: 'department',
          rawValues: ['HR', 'Human Resources'],
          proposal: 'Human Resources',
        },
      ]),
    );
    const rows = await inA((tx) =>
      r.importRows.createMany(
        tx,
        batch.id,
        [2, 3, 4].map((rowNumber) => ({
          batchId: batch.id,
          rowNumber,
          raw: { Department: rowNumber === 2 ? 'HR' : 'Human Resources', Count: rowNumber },
          mapped: { department: 'Human Resources' },
          issueIds: rowNumber < 4 ? [issue!.id] : [],
        })),
      ),
    );
    expect(rows.map((x) => x.outcome)).toEqual(['PENDING', 'PENDING', 'PENDING']);
    expect(rows[0]).not.toHaveProperty('firmId');
    const page = await inA((tx) => r.importRows.forBatch(tx, batch.id, { limit: 2 }));
    expect(page.items.map((x) => x.rowNumber)).toEqual([2, 3]);
    const rest = await inA((tx) =>
      r.importRows.forBatch(tx, batch.id, { afterRowNumber: Number(page.nextCursor) }),
    );
    expect(rest.items.map((x) => x.rowNumber)).toEqual([4]);
    const decided = await inA((tx) =>
      r.importIssues.decideGroup(
        tx,
        batch.id,
        'ALIAS_DEPARTMENT:Human Resources',
        'EDITED',
        'HR & Admin',
      ),
    );
    expect(decided[0]).toMatchObject({ decision: 'EDITED', editedValue: 'HR & Admin' });
    expect(
      await code(
        inA((tx) =>
          r.importIssues.decideGroup(tx, batch.id, 'ALIAS_DEPARTMENT:Human Resources', 'EDITED'),
        ),
      ),
    ).toBe('VALIDATION');
    expect(
      await code(inA((tx) => r.importIssues.decideGroup(tx, batch.id, 'nope', 'ACCEPTED'))),
    ).toBe('NOT_FOUND');
    expect((await inA((tx) => r.importIssues.forBatch(tx, batch.id))).length).toBe(1);
    expect(await inA((tx) => r.importIssues.get(tx, issue!.id))).toMatchObject({
      severity: 'WARNING',
    });
    const outcome = await inA((tx) =>
      r.importRows.setOutcome(tx, rows[0]!.id, { outcome: 'SKIPPED' }),
    );
    expect(outcome.outcome).toBe('SKIPPED');
    expect((await inA((tx) => r.importRows.get(tx, rows[0]!.id)))?.raw).toEqual({
      Department: 'HR',
      Count: 2,
    });
    const moved = await inA((tx) =>
      r.importBatches.update(tx, batch.id, 1, {
        status: 'PARSED',
        counts: { rows: 3, errors: 0, warnings: 1, infos: 0 },
      }),
    );
    expect(moved).toMatchObject({ status: 'PARSED', version: 2 });
    expect(
      (await inA((tx) => r.importBatches.findByFile(tx, world.clientId, 'c'.repeat(64)))).map(
        (b) => b.id,
      ),
    ).toEqual([batch.id]);
    expect((await inA((tx) => r.importBatches.list(tx, world.clientId))).items).toHaveLength(1);
    expect(
      (await inA((tx) => r.mappingTemplates.forClient(tx, world.clientId))).map((m) => m.id),
    ).toEqual([template.id]);
    expect(await inA((tx) => r.importRows.createMany(tx, batch.id, []))).toEqual([]);
    expect(await inA((tx) => r.importIssues.createMany(tx, batch.id, []))).toEqual([]);
    expect(
      await code(
        inA((tx) =>
          r.importRows.createMany(tx, batch.id, [
            { ...rows[0]!, batchId: world.assignmentId, rowNumber: 9 },
          ]),
        ),
      ),
    ).toBe('VALIDATION');
    expect(
      await code(
        inA((tx) =>
          r.importRows.createMany(tx, world.assignmentId, [
            { ...rows[0]!, batchId: world.assignmentId, rowNumber: 9 },
          ]),
        ),
      ),
    ).toBe('NOT_FOUND');
  });

  it('creates a batch under a ticket id, lists newest first, and removes issue groups', async () => {
    const base = {
      clientId: world.clientId,
      createdById: world.approverId,
      fileName: 'register.xlsx',
      sheetName: null,
      mapping: [],
      mappingTemplateId: null,
      counts: null,
      dryRun: null,
      committedAt: null,
      failureCode: null,
    };
    const older = await inA((tx) =>
      r.importBatches.create(tx, { ...base, fileSha256: 'd'.repeat(64) }),
    );
    // The upload ticket's id: batches sort by when their id was made.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const ticket = uuidv7();
    const batch = await inA((tx) =>
      r.importBatches.create(tx, { ...base, id: ticket, fileSha256: 'e'.repeat(64) }),
    );
    expect(batch.id).toBe(ticket);
    expect(
      await code(
        inA((tx) =>
          r.importBatches.create(tx, { ...base, id: ticket, fileSha256: 'f'.repeat(64) }),
        ),
      ),
    ).toBe('DUPLICATE');
    expect(
      await code(
        inA((tx) =>
          r.importBatches.create(tx, {
            ...base,
            id: '01920000-0000-4000-8000-000000000001',
            fileSha256: 'f'.repeat(64),
          }),
        ),
      ),
    ).toBe('VALIDATION');
    const first = await inA((tx) => r.importBatches.list(tx, world.clientId, { limit: 1 }));
    expect(first.items.map((b) => b.id)).toEqual([batch.id]);
    const next = await inA((tx) =>
      r.importBatches.list(tx, world.clientId, { cursor: first.nextCursor, limit: 200 }),
    );
    expect(next.items.map((b) => b.id)).toContain(older.id);
    expect(next.items.map((b) => b.id)).not.toContain(batch.id);
    const oldestFirst = await inA((tx) =>
      r.importBatches.list(tx, world.clientId, { order: 'asc', limit: 200 }),
    );
    expect(oldestFirst.items.at(-1)!.id).toBe(batch.id);

    const issue = (groupKey: string, batchId: string) => ({
      batchId,
      groupKey,
      type: 'ALIAS_DEPARTMENT' as const,
      severity: 'WARNING' as const,
      rowNumbers: [2],
      field: 'department' as const,
      rawValues: ['HR'],
      proposal: 'Human Resources',
    });
    await inA((tx) =>
      r.importIssues.createMany(tx, batch.id, [
        issue('g1', batch.id),
        issue('g1', batch.id),
        issue('g2', batch.id),
        issue('g3', batch.id),
      ]),
    );
    await inA((tx) => r.importIssues.createMany(tx, older.id, [issue('g1', older.id)]));
    // Another firm, or a client context of another client, does not see the batch and deletes nothing.
    expect(await code(inB((tx) => r.importIssues.removeGroups(tx, batch.id, ['g1', 'g2'])))).toBe(
      'NOT_FOUND',
    );
    expect(
      await inB(async (tx) => {
        const raw = await tx.execute(sql`DELETE FROM import_issue WHERE batch_id = ${batch.id}`);
        return raw.rowCount;
      }),
    ).toBe(0);
    const otherClient: TenantContext = {
      firmId: firmA,
      personId: null,
      clientIds: [uuidv7()],
      requestId: 'repo-test',
    };
    expect(
      await code(
        t.db.withTenant(otherClient, (tx) => r.importIssues.removeGroups(tx, batch.id, ['g1'])),
      ),
    ).toBe('NOT_FOUND');
    expect(await inA((tx) => r.importIssues.removeGroups(tx, batch.id, []))).toBe(0);
    expect(await inA((tx) => r.importIssues.removeGroups(tx, batch.id, ['g1', 'g2']))).toBe(3);
    expect(
      (await inA((tx) => r.importIssues.forBatch(tx, batch.id))).map((i) => i.groupKey),
    ).toEqual(['g3']);
    // The same group key in another batch stays.
    expect(
      (await inA((tx) => r.importIssues.forBatch(tx, older.id))).map((i) => i.groupKey),
    ).toEqual(['g1']);
    expect(await code(inA((tx) => r.importIssues.removeGroups(tx, uuidv7(), ['g1'])))).toBe(
      'NOT_FOUND',
    );
    // From COMMITTING on, issues are the record of the cleaning: the repository and RLS both keep them.
    for (const status of ['COMMITTING', 'COMMITTED', 'FAILED', 'CANCELLED'] as const) {
      const removed = await inA(async (tx) => {
        await tx.execute(sql`UPDATE import_batch SET status = ${status} WHERE id = ${older.id}`);
        const refused = await code(r.importIssues.removeGroups(tx, older.id, ['g1']));
        const raw = await tx.execute(sql`DELETE FROM import_issue WHERE batch_id = ${older.id}`);
        return { refused, rows: raw.rowCount };
      });
      expect(removed, status).toEqual({ refused: 'FORBIDDEN', rows: 0 });
    }
    expect(
      (await inA((tx) => r.importIssues.forBatch(tx, older.id))).map((i) => i.groupKey),
    ).toEqual(['g1']);
  });
});
