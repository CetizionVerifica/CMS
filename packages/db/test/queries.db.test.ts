import { DEFAULT_CLIENT_SETTINGS } from '@canopy/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantTx } from '../src/database.js';
import { DbError } from '../src/errors.js';
import * as r from '../src/repositories/index.js';
import { systemContext, type TenantContext } from '../src/tenant-context.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';

/** The calls M6's store needs: query/findAll, people and obligation lookups, instance reassignment. */

let t: TestDatabase;
let firmA: string;

interface World {
  clientId: string;
  otherClientId: string;
  unitId: string;
  departmentIds: Record<string, string>;
  ownerId: string;
  approverId: string;
  standInId: string;
  adminId: string;
  obligationId: string;
  assignmentId: string;
}
let w: World;

const inA = <T>(fn: (tx: TenantTx) => Promise<T>) =>
  t.db.withTenant(systemContext(firmA, 'queries-test'), fn);

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    return e instanceof DbError ? e.code : `not a DbError: ${String(e)}`;
  }
  return 'resolved';
}

function instance(month: string, state: string) {
  return {
    clientId: w.clientId,
    unitId: w.unitId,
    assignmentId: w.assignmentId,
    periodStart: `2026-${month}-01`,
    periodEnd: `2026-${month}-28`,
    dueDate: `2026-${month}-07`,
    workflowState: state,
    pendingKind: state === 'SUBMITTED' ? 'COMPLETION' : null,
    completedOn: state === 'APPROVED' || state === 'SUBMITTED' ? `2026-${month}-05` : null,
    naReason: null,
    ownerId: w.ownerId,
    approverId: w.approverId,
    submittedAt: null,
    approvedAt: null,
    dueDateOverridden: false,
  } as unknown as Parameters<typeof r.instances.create>[1];
}

beforeAll(async () => {
  t = await createTestDatabase();
  firmA = await t.admin.createFirm({ name: 'Demo Advisory' });
  w = await inA(async (tx) => {
    const client = await r.clients.create(tx, {
      name: 'Kestrel Metals Group',
      settings: DEFAULT_CLIENT_SETTINGS,
    });
    const other = await r.clients.create(tx, {
      name: 'Osprey Textiles Group',
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
      city: 'Belur',
    });
    const unit = await r.units.create(tx, {
      clientId: client.id,
      companyId: company.id,
      name: 'Belur Plant',
      locationId: location.id,
    });
    const departmentIds: Record<string, string> = {};
    for (const [name, aliases] of [
      ['Finance', ['Accounts']],
      ['Human Resources', ['HR']],
      ['EHS', []],
      ['Admin 100%', []],
      ['Legal', []],
    ] as const) {
      departmentIds[name] = (
        await r.departments.create(tx, { clientId: client.id, name, aliases: [...aliases] })
      ).id;
    }
    await r.departments.archive(tx, departmentIds['Legal']!, 1);
    await r.departments.create(tx, { clientId: other.id, name: 'Finance', aliases: [] });
    const person = (name: string) =>
      r.people.create(tx, {
        displayName: name,
        nameNormalized: name.toLowerCase(),
        email: null,
        status: 'UNCLAIMED',
      });
    const owner = await person('Owner 01');
    const approver = await person('Approver 01');
    const standIn = await person('Stand In');
    const admin = await person('Admin 01');
    await r.memberships.create(tx, {
      personId: admin.id,
      role: 'FIRM_ADMIN',
      clientId: null,
      consultantClientIds: null,
      unitIds: null,
      expiresAt: null,
    });
    await r.memberships.create(tx, {
      personId: standIn.id,
      role: 'OWNER',
      clientId: other.id,
      consultantClientIds: null,
      unitIds: null,
      expiresAt: null,
    });
    const act = await r.acts.create(tx, {
      name: 'Factories Act, 1948',
      shortName: null,
      jurisdiction: 'CENTRAL',
      stateCode: null,
      aliases: [],
    });
    const category = await r.categories.create(tx, { name: 'Returns', aliases: [] });
    const obligation = await r.obligations.create(tx, {
      externalRef: null,
      domain: 'HRS',
      jurisdiction: 'CENTRAL',
      stateCode: null,
      actId: act.id,
      categoryId: category.id,
      title: 'Annual return',
      description: 'File the annual return.',
      applicabilityText: null,
      criticality: 'MEDIUM',
      timelineType: 'TIME_BASED',
      recurrenceRule: { kind: 'MONTHLY', day: 7, offsetMonths: 1 },
      ruleStatus: 'CONFIRMED',
      evidenceRequired: false,
      forms: [],
      logSheets: [],
      libraryVersion: 1,
    });
    await r.obligations.create(tx, {
      externalRef: null,
      domain: 'HRS',
      jurisdiction: 'CENTRAL',
      stateCode: null,
      actId: act.id,
      categoryId: category.id,
      title: 'Unassigned obligation',
      description: 'Not assigned anywhere.',
      applicabilityText: null,
      criticality: 'LOW',
      timelineType: 'TIME_BASED',
      recurrenceRule: { kind: 'MONTHLY', day: 7, offsetMonths: 1 },
      ruleStatus: 'CONFIRMED',
      evidenceRequired: false,
      forms: [],
      logSheets: [],
      libraryVersion: 1,
    });
    const assignment = await r.assignments.create(tx, {
      clientId: client.id,
      unitId: unit.id,
      obligationId: obligation.id,
      departmentId: departmentIds['Finance']!,
      defaultOwnerId: owner.id,
      defaultApproverId: approver.id,
      applicability: 'APPLICABLE',
      naReason: null,
      activeFrom: '2026-04-01' as never,
      activeTo: null,
    });
    return {
      clientId: client.id,
      otherClientId: other.id,
      unitId: unit.id,
      departmentIds,
      ownerId: owner.id,
      approverId: approver.id,
      standInId: standIn.id,
      adminId: admin.id,
      obligationId: obligation.id,
      assignmentId: assignment.id,
    };
  });
  await inA(async (tx) => {
    for (const [month, state] of [
      ['05', 'OPEN'],
      ['06', 'SENT_BACK'],
      ['07', 'SUBMITTED'],
      ['08', 'APPROVED'],
    ] as const) {
      await r.instances.create(tx, instance(month, state));
    }
  });
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('query and findAll', () => {
  const names = (items: { name: string }[]) => items.map((d) => d.name);

  it('filters by field equality and lists, leaving archived rows out unless asked', async () => {
    await inA(async (tx) => {
      const mine = await r.departments.query(tx, {
        where: { clientId: w.clientId },
        orderBy: 'name',
      });
      expect(names(mine.items)).toEqual(['Admin 100%', 'EHS', 'Finance', 'Human Resources']);
      const both = await r.departments.query(tx, {
        where: { clientId: [w.clientId, w.otherClientId], name: 'Finance' },
      });
      expect(both.items).toHaveLength(2);
      const archived = await r.departments.query(tx, {
        where: { clientId: w.clientId },
        includeArchived: true,
        orderBy: 'name',
        count: true,
      });
      expect(names(archived.items)).toContain('Legal');
      expect(archived.total).toBe(5);
      expect((await r.departments.query(tx, { where: { clientId: [] } })).items).toEqual([]);
    });
  });

  it('searches case-insensitively on the named fields, with LIKE characters taken literally', async () => {
    await inA(async (tx) => {
      const hr = await r.departments.query(tx, { search: { text: 'hum', fields: ['name'] } });
      expect(names(hr.items)).toEqual(['Human Resources']);
      const byAlias = await r.departments.query(tx, {
        search: { text: 'accounts', fields: ['name', 'aliases'] },
      });
      expect(names(byAlias.items)).toEqual(['Finance']);
      const percent = await r.departments.query(tx, { search: { text: '100%', fields: ['name'] } });
      expect(names(percent.items)).toEqual(['Admin 100%']);
      const underscore = await r.departments.query(tx, { search: { text: '_', fields: ['name'] } });
      expect(underscore.items).toEqual([]);
    });
  });

  it('pages by the sort field then id, with a total that ignores the cursor', async () => {
    await inA(async (tx) => {
      const q = {
        where: { clientId: w.clientId },
        orderBy: 'name' as const,
        limit: 2,
        count: true,
      };
      const first = await r.departments.query(tx, q);
      expect(names(first.items)).toEqual(['Admin 100%', 'EHS']);
      expect(first.total).toBe(4);
      const last = first.items.at(-1)!;
      const second = await r.departments.query(tx, {
        ...q,
        after: { key: last.name, id: last.id },
      });
      expect(names(second.items)).toEqual(['Finance', 'Human Resources']);
      expect(second.total).toBe(4);
    });
  });

  it('pages over a nullable sort field, empty values first', async () => {
    await inA(async (tx) => {
      const all = await r.obligations.query(tx, { orderBy: 'externalRef', limit: 1 });
      expect(all.items[0]!.externalRef).toBeNull();
      const next = await r.obligations.query(tx, {
        orderBy: 'externalRef',
        limit: 5,
        after: { key: '', id: all.items[0]!.id },
      });
      expect(next.items).toHaveLength(1);
      expect(next.items[0]!.id).not.toBe(all.items[0]!.id);
    });
  });

  it('refuses a field the table does not have', async () => {
    expect(await code(inA((tx) => r.departments.query(tx, { orderBy: 'nope' as never })))).toBe(
      'VALIDATION',
    );
    expect(await code(inA((tx) => r.departments.findAll(tx, { nope: 1 } as never)))).toBe(
      'VALIDATION',
    );
  });

  it('findAll returns every non-archived match', async () => {
    const rows = await inA((tx) => r.departments.findAll(tx, { clientId: w.clientId }));
    expect(names(rows).sort()).toEqual(['Admin 100%', 'EHS', 'Finance', 'Human Resources']);
  });
});

describe('lookups', () => {
  const clientUser = (): TenantContext => ({
    firmId: firmA,
    personId: null,
    clientIds: [w.clientId],
    requestId: 'client-user',
  });

  it('lists the people of a client, and nothing for a client the context cannot see', async () => {
    expect(await inA((tx) => r.people.idsInClient(tx, w.clientId))).toEqual(
      [w.ownerId, w.approverId].sort(),
    );
    expect(await inA((tx) => r.people.idsInClient(tx, w.otherClientId))).toEqual([w.standInId]);
    expect(
      await t.db.withTenant(clientUser(), (tx) => r.people.idsInClient(tx, w.otherClientId)),
    ).toEqual([]);
  });

  it('lists firm staff', async () => {
    expect(await inA((tx) => r.people.firmStaffIds(tx))).toEqual([w.adminId]);
    expect(await t.db.withTenant(clientUser(), (tx) => r.people.firmStaffIds(tx))).toEqual([]);
  });

  it('lists obligations assigned in visible clients', async () => {
    expect(await inA((tx) => r.assignments.obligationIds(tx))).toEqual([w.obligationId]);
    const other: TenantContext = { ...clientUser(), clientIds: [w.otherClientId] };
    expect(await t.db.withTenant(other, (tx) => r.assignments.obligationIds(tx))).toEqual([]);
  });
});

describe('instance reassignment', () => {
  it('reassignOpen changes only OPEN and SENT_BACK instances and reports the before values', async () => {
    const changed = await inA((tx) =>
      r.instances.reassignOpen(tx, w.assignmentId, { ownerId: w.standInId }),
    );
    expect(changed).toHaveLength(2);
    for (const c of changed) {
      expect(c).toMatchObject({
        clientId: w.clientId,
        version: 2,
        before: { ownerId: w.ownerId, approverId: w.approverId },
        after: { ownerId: w.standInId, approverId: w.approverId },
      });
    }
    // Nothing left to change: no rows, no version bump.
    expect(
      await inA((tx) => r.instances.reassignOpen(tx, w.assignmentId, { ownerId: w.standInId })),
    ).toEqual([]);
    const states = await inA(async (tx) =>
      (await r.instances.list(tx, w.assignmentId)).items.map((i) => [
        i.workflowState,
        i.ownerId === w.standInId,
      ]),
    );
    expect(states).toEqual([
      ['OPEN', true],
      ['SENT_BACK', true],
      ['SUBMITTED', false],
      ['APPROVED', false],
    ]);
  });

  it('replacePerson moves every non-archived instance in any state', async () => {
    const changed = await inA((tx) => r.instances.replacePerson(tx, w.approverId, w.ownerId));
    expect(changed).toHaveLength(4);
    expect(
      changed.every(
        (c) => c.after.approverId === w.ownerId && c.before.approverId === w.approverId,
      ),
    ).toBe(true);
    expect(await inA((tx) => r.instances.replacePerson(tx, w.approverId, w.ownerId))).toEqual([]);
  });

  it('a client context cannot reassign instances of a client it cannot see', async () => {
    const other: TenantContext = {
      firmId: firmA,
      personId: null,
      clientIds: [w.otherClientId],
      requestId: 'x',
    };
    expect(
      await t.db.withTenant(other, (tx) =>
        r.instances.reassignOpen(tx, w.assignmentId, { ownerId: w.approverId }),
      ),
    ).toEqual([]);
  });
});
