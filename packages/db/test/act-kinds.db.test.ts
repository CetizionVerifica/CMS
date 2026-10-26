import { DEFAULT_CLIENT_SETTINGS, LocalDate, type ActKind } from '@canopy/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantTx } from '../src/database.js';
import { DbError } from '../src/errors.js';
import * as r from '../src/repositories/index.js';
import { systemContext, type TenantContext } from '../src/tenant-context.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';

/**
 * Act-kind reads (ISO-2f, docs/iso/plan.md §4.6): the `actKinds` filter on the register (and so the approvals, tasks,
 * calendar, overview, breakdown and report reads built on it), the evidence vault, the digest's score items and the
 * library and assignment lists; the by-id act-kind lookups behind the add-on's off switch; and
 * `Database.listFirmIdsWithFeature` (migration 0042).
 */

let t: TestDatabase;
let firmId: string;

interface Side {
  actId: string;
  obligationId: string;
  assignmentId: string;
  instanceId: string;
  evidenceId: string;
}
interface World {
  clientId: string;
  otherClientId: string;
  ownerId: string;
  approverId: string;
  statute: Side;
  standard: Side;
}
let w: World;

const firmAdmin = (): TenantContext => ({
  firmId,
  personId: w.approverId,
  clientIds: 'ALL',
  requestId: 'act-kinds-test',
});
const asAdmin = <T>(fn: (tx: TenantTx) => Promise<T>) => t.db.withTenant(firmAdmin(), fn);
const day = (value: string) => LocalDate.parse(value);

/** The filters each read is tried with, and the side (or sides) it must return. */
const CASES: {
  name: string;
  actKinds: ActKind[] | undefined;
  sides: ('statute' | 'standard')[];
}[] = [
  { name: 'STATUTE only', actKinds: ['STATUTE'], sides: ['statute'] },
  { name: 'STANDARD only', actKinds: ['STANDARD'], sides: ['standard'] },
  { name: 'both, listed', actKinds: ['STATUTE', 'STANDARD'], sides: ['statute', 'standard'] },
  { name: 'both, absent', actKinds: undefined, sides: ['statute', 'standard'] },
  { name: 'none, empty list', actKinds: [], sides: [] },
];
const ids = (sides: ('statute' | 'standard')[], key: keyof Side) =>
  sides.map((side) => w[side][key]).sort();
const sorted = (values: string[]) => [...values].sort();

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    return e instanceof DbError ? e.code : String(e);
  }
  return 'resolved';
}

beforeAll(async () => {
  t = await createTestDatabase();
  firmId = await t.admin.createFirm({ name: 'Demo Advisory' });
  w = await t.db.withTenant(systemContext(firmId, 'act-kinds-test'), async (tx) => {
    const location = await r.locations.create(tx, {
      country: 'India',
      countryCode: 'IN',
      state: 'West Bengal',
      stateCode: 'WB',
      city: 'Riverbend',
    });
    const person = (name: string) =>
      r.people.create(tx, {
        displayName: name,
        nameNormalized: name.toLowerCase(),
        email: null,
        status: 'UNCLAIMED',
      });
    const owner = await person('Owner One');
    const approver = await person('Approver One');
    const category = await r.categories.create(tx, { name: 'Safety', aliases: [] });
    const clientWithUnit = async (name: string) => {
      const client = await r.clients.create(tx, { name, settings: DEFAULT_CLIENT_SETTINGS });
      const company = await r.companies.create(tx, { clientId: client.id, name: `${name} Ltd` });
      const unit = await r.units.create(tx, {
        clientId: client.id,
        companyId: company.id,
        name: 'Riverbend',
        locationId: location.id,
      });
      const department = await r.departments.create(tx, {
        clientId: client.id,
        name: 'Safety',
        aliases: [],
      });
      return { clientId: client.id, unitId: unit.id, departmentId: department.id };
    };
    const kestrel = await clientWithUnit('Kestrel Metals Group');
    const osprey = await clientWithUnit('Osprey Textiles Group');

    const side = async (kind: ActKind, name: string, title: string): Promise<Side> => {
      const act = await r.acts.create(tx, {
        name,
        shortName: null,
        jurisdiction: 'CENTRAL',
        stateCode: null,
        aliases: [],
        kind,
      });
      const obligation = await r.obligations.create(tx, {
        externalRef: null,
        domain: 'EHS',
        jurisdiction: 'CENTRAL',
        stateCode: null,
        actId: act.id,
        categoryId: category.id,
        title,
        description: `${title}.`,
        applicabilityText: null,
        criticality: 'HIGH',
        timelineType: 'TIME_BASED',
        recurrenceRule: { kind: 'ONE_TIME', dueDate: day('2026-12-31') },
        ruleStatus: 'CONFIRMED',
        evidenceRequired: false,
        forms: [],
        logSheets: [],
        libraryVersion: 1,
      });
      const assignment = await r.assignments.create(tx, {
        clientId: kestrel.clientId,
        unitId: kestrel.unitId,
        obligationId: obligation.id,
        departmentId: kestrel.departmentId,
        defaultOwnerId: owner.id,
        defaultApproverId: approver.id,
        applicability: 'APPLICABLE',
        naReason: null,
        activeFrom: day('2026-04-01'),
        activeTo: null,
      });
      const instance = await r.instances.create(tx, {
        clientId: kestrel.clientId,
        unitId: kestrel.unitId,
        assignmentId: assignment.id,
        periodStart: '2026-11-20',
        periodEnd: '2026-11-20',
        dueDate: '2026-11-27',
        workflowState: 'SUBMITTED',
        pendingKind: 'COMPLETION',
        completedOn: '2026-11-21',
        naReason: null,
        ownerId: owner.id,
        approverId: approver.id,
        submittedAt: '2026-11-21T09:00:00.000Z',
        approvedAt: null,
        dueDateOverridden: false,
      } as unknown as Parameters<typeof r.instances.create>[1]);
      const evidence = await r.evidence.create(tx, {
        instanceId: instance.id,
        clientId: kestrel.clientId,
        fileName: `${kind.toLowerCase()}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: 2048,
        sha256: 'b'.repeat(64),
        storageKey: `evidence/${instance.id}/${kind.toLowerCase()}.pdf`,
        uploadedById: owner.id,
      });
      return {
        actId: act.id,
        obligationId: obligation.id,
        assignmentId: assignment.id,
        instanceId: instance.id,
        evidenceId: evidence.id,
      };
    };
    return {
      clientId: kestrel.clientId,
      otherClientId: osprey.clientId,
      ownerId: owner.id,
      approverId: approver.id,
      statute: await side('STATUTE', 'Factories Act, 1948', 'Report an accident'),
      // Same name as the statute: names are unique per kind (migration 0039).
      standard: await side('STANDARD', 'Factories Act, 1948', 'Review the quality policy'),
    };
  });
});

afterAll(async () => {
  await t?.drop();
});

describe('the actKinds filter', () => {
  for (const c of CASES) {
    describe(c.name, () => {
      const filter = { actKinds: c.actKinds };

      it('on the register', async () => {
        const page = await asAdmin((tx) => r.instances.register(tx, w.clientId, filter));
        expect(sorted(page.items.map((x) => x.id))).toEqual(ids(c.sides, 'instanceId'));
      });

      it('on the approvals and tasks reads (register by approver or owner and state)', async () => {
        const approvals = await asAdmin((tx) =>
          r.instances.register(tx, w.clientId, {
            ...filter,
            approverId: w.approverId,
            workflowState: ['SUBMITTED'],
          }),
        );
        expect(sorted(approvals.items.map((x) => x.id))).toEqual(ids(c.sides, 'instanceId'));
        const tasks = await asAdmin((tx) =>
          r.instances.register(tx, w.clientId, {
            ...filter,
            ownerId: w.ownerId,
            dueFrom: '2026-11-01',
            dueTo: '2026-11-30',
          }),
        );
        expect(sorted(tasks.items.map((x) => x.id))).toEqual(ids(c.sides, 'instanceId'));
      });

      it('on the evidence vault', async () => {
        const page = await asAdmin((tx) => r.evidence.vault(tx, w.clientId, filter));
        expect(sorted(page.items.map((x) => x.id))).toEqual(ids(c.sides, 'evidenceId'));
      });

      it('on the digest score items', async () => {
        const items = await asAdmin((tx) =>
          r.jobs.listScoreItems(tx, w.clientId, { from: '2026-11-01', to: '2026-11-30' }, filter),
        );
        expect(sorted(items.map((x) => x.instanceId))).toEqual(ids(c.sides, 'instanceId'));
      });

      it('on the act lists', async () => {
        const list = await asAdmin((tx) => r.acts.list(tx, {}, filter));
        expect(sorted(list.items.map((x) => x.id))).toEqual(ids(c.sides, 'actId'));
        const query = await asAdmin((tx) => r.acts.query(tx, { count: true }, filter));
        expect(sorted(query.items.map((x) => x.id))).toEqual(ids(c.sides, 'actId'));
        expect(query.total).toBe(c.sides.length);
      });

      it('on the obligation lists', async () => {
        const list = await asAdmin((tx) => r.obligations.list(tx, {}, filter));
        expect(sorted(list.items.map((x) => x.id))).toEqual(ids(c.sides, 'obligationId'));
        const query = await asAdmin((tx) => r.obligations.query(tx, { count: true }, filter));
        expect(sorted(query.items.map((x) => x.id))).toEqual(ids(c.sides, 'obligationId'));
        expect(query.total).toBe(c.sides.length);
      });

      it('on the assignment lists', async () => {
        const list = await asAdmin((tx) => r.assignments.list(tx, w.clientId, {}, filter));
        expect(sorted(list.items.map((x) => x.id))).toEqual(ids(c.sides, 'assignmentId'));
        const query = await asAdmin((tx) =>
          r.assignments.query(tx, { where: { clientId: w.clientId }, count: true }, filter),
        );
        expect(sorted(query.items.map((x) => x.id))).toEqual(ids(c.sides, 'assignmentId'));
        expect(query.total).toBe(c.sides.length);
      });
    });
  }

  it('keeps the other filters: a STANDARD filter on another client finds nothing', async () => {
    const page = await asAdmin((tx) =>
      r.instances.register(tx, w.otherClientId, { actKinds: ['STANDARD'] }),
    );
    expect(page.items).toEqual([]);
  });

  it('refuses an unknown kind or a repeat-free list longer than the enum', async () => {
    const bad = ['LAW'] as unknown as ActKind[];
    expect(
      await failure(asAdmin((tx) => r.instances.register(tx, w.clientId, { actKinds: bad }))),
    ).toBe('VALIDATION');
    expect(
      await failure(asAdmin((tx) => r.evidence.vault(tx, w.clientId, { actKinds: bad }))),
    ).toBe('VALIDATION');
    expect(await failure(asAdmin((tx) => r.obligations.list(tx, {}, { actKinds: bad })))).toBe(
      'VALIDATION',
    );
    const three = ['STATUTE', 'STANDARD', 'STATUTE'] as ActKind[];
    expect(
      await failure(
        asAdmin((tx) =>
          r.jobs.listScoreItems(
            tx,
            w.clientId,
            { from: '2026-11-01', to: '2026-11-30' },
            { actKinds: three },
          ),
        ),
      ),
    ).toBe('VALIDATION');
  });
});

describe('actKindOf', () => {
  it('names the kind behind an instance, an obligation and an assignment', async () => {
    const kinds = await asAdmin(async (tx) => ({
      statute: [
        await r.actKindOf.instance(tx, w.statute.instanceId),
        await r.actKindOf.obligation(tx, w.statute.obligationId),
        await r.actKindOf.assignment(tx, w.statute.assignmentId),
      ],
      standard: [
        await r.actKindOf.instance(tx, w.standard.instanceId),
        await r.actKindOf.obligation(tx, w.standard.obligationId),
        await r.actKindOf.assignment(tx, w.standard.assignmentId),
      ],
    }));
    expect(kinds).toEqual({
      statute: ['STATUTE', 'STATUTE', 'STATUTE'],
      standard: ['STANDARD', 'STANDARD', 'STANDARD'],
    });
  });

  it('answers for an archived assignment too', async () => {
    const kind = await asAdmin(async (tx) => {
      const a = await r.assignments.require(tx, w.standard.assignmentId);
      await r.assignments.archive(tx, a.id, a.version);
      const k = await r.actKindOf.assignment(tx, a.id);
      const archived = await r.assignments.require(tx, a.id);
      await r.assignments.restore(tx, a.id, archived.version);
      return k;
    });
    expect(kind).toBe('STANDARD');
  });

  it('is null for a row that does not exist or that the context cannot see', async () => {
    const missing = '01890000-0000-7000-8000-000000000000';
    const outsider: TenantContext = {
      firmId,
      personId: w.ownerId,
      clientIds: [w.otherClientId],
      requestId: 'act-kinds-test',
    };
    const seen = await t.db.withTenant(outsider, async (tx) => [
      await r.actKindOf.instance(tx, w.standard.instanceId),
      await r.actKindOf.assignment(tx, w.standard.assignmentId),
      await r.actKindOf.instance(tx, missing),
      await r.actKindOf.obligation(tx, missing),
      await r.actKindOf.assignment(tx, missing),
    ]);
    expect(seen).toEqual([null, null, null, null, null]);
    const otherFirm = await t.admin.createFirm({ name: 'Second Ledger Consulting' });
    const fromOtherFirm = await t.db.withTenant(systemContext(otherFirm, 'act-kinds-test'), (tx) =>
      r.actKindOf.obligation(tx, w.standard.obligationId),
    );
    expect(fromOtherFirm).toBeNull();
  });

  it('refuses an id that is not a uuid', async () => {
    expect(await failure(asAdmin((tx) => r.actKindOf.instance(tx, 'not-an-id')))).toBe(
      'VALIDATION',
    );
  });
});

describe('listFirmIdsWithFeature', () => {
  const FLAG = 'isoManagement';
  let firms: Record<string, string>;

  beforeAll(async () => {
    await t.ownerQuery(
      `INSERT INTO platform.plan (code, name, limits, features) VALUES
         ('ISO_PLAN', 'With ISO', '{"companies": null, "units": null, "users": null, "storageBytes": null}', '{isoManagement}'),
         ('PLAIN_PLAN', 'Without ISO', '{"companies": null, "units": null, "users": null, "storageBytes": null}', '{importer}')`,
    );
    const firm = async (
      name: string,
      planCode: string,
      status: string,
      override?: { features: string[]; removed: string[] },
    ) => {
      const id = await t.admin.createFirm({ name });
      // The trial and deletion checks want their dates with those statuses.
      await t.ownerQuery(
        `UPDATE firm SET plan_code = $2, status = $3::account_status,
           trial_ends_on = CASE WHEN $3::account_status = 'TRIAL' THEN DATE '2026-12-31' END,
           deletion_requested_at = CASE WHEN $3::account_status = 'PENDING_DELETION' THEN now() END,
           status_before_deletion = CASE WHEN $3::account_status = 'PENDING_DELETION' THEN 'ACTIVE'::account_status END
         WHERE id = $1`,
        [id, planCode, status],
      );
      if (override) {
        await t.ownerQuery(
          `INSERT INTO platform.account_override (account_id, features, removed_features) VALUES ($1, $2, $3)`,
          [id, override.features, override.removed],
        );
      }
      return id;
    };
    firms = {
      fromPlan: await firm('Kestrel Advisory', 'ISO_PLAN', 'ACTIVE'),
      fromPlanTrial: await firm('Osprey Advisory', 'ISO_PLAN', 'TRIAL'),
      fromOverride: await firm('Riverbend Advisory', 'PLAIN_PLAN', 'ACTIVE', {
        features: [FLAG],
        removed: [],
      }),
      removedByOverride: await firm('Stonebridge Advisory', 'ISO_PLAN', 'ACTIVE', {
        features: [],
        removed: [FLAG],
      }),
      withoutFlag: await firm('Highmoor Advisory', 'PLAIN_PLAN', 'ACTIVE'),
      suspended: await firm('Kestrel Suspended Advisory', 'ISO_PLAN', 'SUSPENDED'),
      pendingDeletion: await firm('Kestrel Closing Advisory', 'ISO_PLAN', 'PENDING_DELETION'),
      provisioning: await firm('Kestrel New Advisory', 'ISO_PLAN', 'PROVISIONING'),
    };
  });

  it('lists TRIAL and ACTIVE accounts with the flag from the plan or an override, in id order', async () => {
    const listed = await t.db.listFirmIdsWithFeature(FLAG);
    expect(listed).toEqual(sorted([firms.fromPlan!, firms.fromPlanTrial!, firms.fromOverride!]));
    // Every firm of the file: the act-kind firm's default plan has no add-on.
    expect(listed).not.toContain(firmId);
  });

  it('leaves out a flag removed by an override, a plan without it, and accounts not in TRIAL or ACTIVE', async () => {
    const listed = await t.db.listFirmIdsWithFeature(FLAG);
    for (const name of [
      'removedByOverride',
      'withoutFlag',
      'suspended',
      'pendingDeletion',
      'provisioning',
    ]) {
      expect(listed, name).not.toContain(firms[name]);
    }
  });

  it('is empty for a flag no account has, and refuses a malformed flag', async () => {
    expect(await t.db.listFirmIdsWithFeature('nobodyHasThis')).toEqual([]);
    expect(await failure(t.db.listFirmIdsWithFeature("x'; DROP TABLE firm; --"))).toBe(
      'VALIDATION',
    );
  });

  it('returns ids only, runs for the app role and no other, and is owned by canopy_lookup', async () => {
    const { rows } = await t.ownerQuery<{
      result: string;
      definer: boolean;
      owner: string;
      config: string[];
      grantees: string[];
    }>(`
      SELECT pg_get_function_result(p.oid) AS result, p.prosecdef AS definer,
             pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config,
             ARRAY(SELECT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
                   FROM aclexplode(p.proacl) a ORDER BY 1)::text[] AS grantees
      FROM pg_proc p WHERE p.proname = 'canopy_list_firm_ids_with_feature'`);
    expect(rows).toEqual([
      {
        result: 'SETOF uuid',
        definer: true,
        owner: 'canopy_lookup',
        config: ['search_path=public, pg_temp'],
        grantees: ['canopy_app', 'canopy_lookup'],
      },
    ]);
    const roles = await t.ownerQuery<{ role: string; can: boolean }>(`
      SELECT r AS role, has_function_privilege(r, 'canopy_list_firm_ids_with_feature(text)', 'EXECUTE') AS can
      FROM unnest(ARRAY['canopy_app', 'canopy_operator', 'canopy_platform', 'canopy_jobs', 'canopy_purge']) r
      ORDER BY 1`);
    expect(roles.rows).toEqual([
      { role: 'canopy_app', can: true },
      { role: 'canopy_jobs', can: false },
      { role: 'canopy_operator', can: false },
      { role: 'canopy_platform', can: false },
      { role: 'canopy_purge', can: false },
    ]);
  });

  it('gives canopy_lookup column grants only: no whole platform table, no plan or override column it does not read', async () => {
    const tables = await t.ownerQuery(`
      SELECT table_name FROM information_schema.role_table_grants
      WHERE grantee = 'canopy_lookup' AND table_schema = 'platform'`);
    expect(tables.rows).toEqual([]);
    const columns = await t.ownerQuery<{ table: string; column: string; privilege: string }>(`
      SELECT table_name AS table, column_name AS column, privilege_type AS privilege
      FROM information_schema.column_privileges
      WHERE grantee = 'canopy_lookup' AND (table_schema = 'platform' OR table_name = 'firm')
      ORDER BY 1, 2`);
    expect(columns.rows).toEqual(
      [
        ['account_override', 'account_id'],
        ['account_override', 'features'],
        ['account_override', 'removed_features'],
        ['firm', 'archived_at'],
        ['firm', 'id'],
        ['firm', 'name'],
        ['firm', 'plan_code'],
        ['firm', 'status'],
        ['plan', 'code'],
        ['plan', 'features'],
      ].map(([table, column]) => ({ table, column, privilege: 'SELECT' })),
    );
  });
});
