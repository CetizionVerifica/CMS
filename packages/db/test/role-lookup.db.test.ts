import { DEFAULT_CLIENT_SETTINGS, type Role } from '@canopy/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantTx } from '../src/database.js';
import { DbError } from '../src/errors.js';
import * as r from '../src/repositories/index.js';
import { systemContext, type TenantContext } from '../src/tenant-context.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';

/**
 * The role lookup of ISO-2i (migration 0044, model §1 rule 5, ADR M16-0004 decision 6): whether a person holds one of
 * some roles in a client, covering a unit, answered for memberships the caller cannot read, as a yes or no, and false
 * for a client the caller may not see.
 */

let t: TestDatabase;
let firmId: string;
let otherFirmId: string;

interface World {
  kestrel: string;
  osprey: string;
  riverbend: string;
  stonebridge: string;
  highmoor: string;
  clientAdmin: string;
  firmAdmin: string;
  kestrelConsultant: string;
  ospreyConsultant: string;
  riverbendOwner: string;
  expiredViewer: string;
  archivedApprover: string;
  ospreyAdmin: string;
  otherFirmAdmin: string;
}
let w: World;

const kestrelAdmin = (): TenantContext => ({
  firmId,
  personId: w.clientAdmin,
  clientIds: [w.kestrel],
  requestId: 'role-lookup-test',
});
const holds = (
  ctx: TenantContext,
  personId: string,
  roles: Role[],
  clientId: string,
  unitId?: string,
) =>
  t.db.withTenant(ctx, (tx) =>
    r.memberships.holdsRole(tx, { personId, roles, clientId, ...(unitId && { unitId }) }),
  );

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
  otherFirmId = await t.admin.createFirm({ name: 'Second Ledger Consulting' });
  const otherFirmAdmin = await t.db.withTenant(
    systemContext(otherFirmId, 'role-lookup-test'),
    async (tx) => {
      const person = await r.people.create(tx, {
        displayName: 'Ledger Admin',
        nameNormalized: 'ledger admin',
        email: null,
        status: 'UNCLAIMED',
      });
      await r.memberships.create(tx, {
        personId: person.id,
        role: 'FIRM_ADMIN',
        clientId: null,
        consultantClientIds: null,
        unitIds: null,
        expiresAt: null,
      });
      return person.id;
    },
  );
  w = await t.db.withTenant(systemContext(firmId, 'role-lookup-test'), async (tx) => {
    const location = await r.locations.create(tx, {
      country: 'India',
      countryCode: 'IN',
      state: 'West Bengal',
      stateCode: 'WB',
      city: 'Riverbend',
    });
    const clientWithUnits = async (name: string, units: string[]) => {
      const client = await r.clients.create(tx, { name, settings: DEFAULT_CLIENT_SETTINGS });
      const company = await r.companies.create(tx, { clientId: client.id, name: `${name} Ltd` });
      const ids: string[] = [];
      for (const unit of units) {
        const made = await r.units.create(tx, {
          clientId: client.id,
          companyId: company.id,
          name: unit,
          locationId: location.id,
        });
        ids.push(made.id);
      }
      return { clientId: client.id, unitIds: ids };
    };
    const kestrel = await clientWithUnits('Kestrel Metals Group', ['Riverbend', 'Stonebridge']);
    const osprey = await clientWithUnits('Osprey Textiles Group', ['Highmoor']);
    const member = async (
      name: string,
      role: Role,
      grant: {
        clientId?: string;
        consultantClientIds?: string[];
        unitIds?: string[];
        expiresAt?: string;
      } = {},
    ) => {
      const person = await r.people.create(tx, {
        displayName: name,
        nameNormalized: name.toLowerCase(),
        email: null,
        status: 'UNCLAIMED',
      });
      const membership = await r.memberships.create(tx, {
        personId: person.id,
        role,
        clientId: grant.clientId ?? null,
        consultantClientIds: grant.consultantClientIds ?? null,
        unitIds: grant.unitIds ?? null,
        expiresAt: grant.expiresAt ?? null,
      });
      return { personId: person.id, membership };
    };
    const archived = await member('Archived Approver', 'APPROVER', { clientId: kestrel.clientId });
    await r.memberships.archive(tx, archived.membership.id, archived.membership.version);
    return {
      kestrel: kestrel.clientId,
      osprey: osprey.clientId,
      riverbend: kestrel.unitIds[0]!,
      stonebridge: kestrel.unitIds[1]!,
      highmoor: osprey.unitIds[0]!,
      clientAdmin: (await member('Kestrel Admin', 'CLIENT_ADMIN', { clientId: kestrel.clientId }))
        .personId,
      firmAdmin: (await member('Firm Admin', 'FIRM_ADMIN')).personId,
      kestrelConsultant: (
        await member('Kestrel Consultant', 'CONSULTANT', {
          consultantClientIds: [kestrel.clientId],
        })
      ).personId,
      ospreyConsultant: (
        await member('Osprey Consultant', 'CONSULTANT', { consultantClientIds: [osprey.clientId] })
      ).personId,
      riverbendOwner: (
        await member('Riverbend Owner', 'OWNER', {
          clientId: kestrel.clientId,
          unitIds: [kestrel.unitIds[0]!],
        })
      ).personId,
      expiredViewer: (
        await member('Expired Viewer', 'VIEWER', {
          clientId: kestrel.clientId,
          expiresAt: '2026-01-01T00:00:00.000Z',
        })
      ).personId,
      archivedApprover: archived.personId,
      ospreyAdmin: (await member('Osprey Admin', 'CLIENT_ADMIN', { clientId: osprey.clientId }))
        .personId,
      otherFirmAdmin,
    };
  });
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('memberships.holdsRole (canopy_person_holds_role)', () => {
  it('answers a client admin about people whose memberships it cannot read', async () => {
    const ctx = kestrelAdmin();
    expect(await holds(ctx, w.kestrelConsultant, ['CONSULTANT'], w.kestrel)).toBe(true);
    expect(await holds(ctx, w.firmAdmin, ['FIRM_ADMIN'], w.kestrel)).toBe(true);
    expect(
      await holds(ctx, w.firmAdmin, ['FIRM_ADMIN', 'CONSULTANT'], w.kestrel, w.stonebridge),
    ).toBe(true);
    expect(await holds(ctx, w.ospreyConsultant, ['CONSULTANT'], w.kestrel)).toBe(false);
    expect(await holds(ctx, w.otherFirmAdmin, ['FIRM_ADMIN'], w.kestrel)).toBe(false);
    // The rows behind those answers stay out of its reach.
    const visible = await t.db.withTenant(ctx, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM membership WHERE person_id IN (${w.firmAdmin}, ${w.kestrelConsultant})`,
      ),
    );
    expect(visible.rows[0]!.n).toBe(0);
  });

  it('is false for a client the caller may not see, though the person holds the role there', async () => {
    expect(await holds(kestrelAdmin(), w.ospreyConsultant, ['CONSULTANT'], w.osprey)).toBe(false);
    expect(await holds(kestrelAdmin(), w.ospreyAdmin, ['CLIENT_ADMIN'], w.osprey)).toBe(false);
    const firmWide = systemContext(firmId, 'role-lookup-test');
    expect(await holds(firmWide, w.ospreyConsultant, ['CONSULTANT'], w.osprey)).toBe(true);
    expect(await holds(firmWide, w.ospreyAdmin, ['CLIENT_ADMIN'], w.osprey)).toBe(true);
  });

  it('covers a unit only through a membership with no units or listing it', async () => {
    const ctx = kestrelAdmin();
    expect(await holds(ctx, w.riverbendOwner, ['OWNER'], w.kestrel)).toBe(true);
    expect(await holds(ctx, w.riverbendOwner, ['OWNER'], w.kestrel, w.riverbend)).toBe(true);
    expect(await holds(ctx, w.riverbendOwner, ['OWNER'], w.kestrel, w.stonebridge)).toBe(false);
    expect(await holds(ctx, w.clientAdmin, ['CLIENT_ADMIN'], w.kestrel, w.stonebridge)).toBe(true);
    // A unit of another client never matches, not even for a firm-wide role.
    const firmWide = systemContext(firmId, 'role-lookup-test');
    expect(await holds(firmWide, w.firmAdmin, ['FIRM_ADMIN'], w.kestrel, w.highmoor)).toBe(false);
  });

  it('needs one of the roles asked, live: not archived, not expired', async () => {
    const ctx = kestrelAdmin();
    expect(await holds(ctx, w.riverbendOwner, ['APPROVER', 'CLIENT_ADMIN'], w.kestrel)).toBe(false);
    expect(await holds(ctx, w.kestrelConsultant, ['FIRM_ADMIN'], w.kestrel)).toBe(false);
    expect(await holds(ctx, w.expiredViewer, ['VIEWER'], w.kestrel)).toBe(false);
    expect(await holds(ctx, w.archivedApprover, ['APPROVER'], w.kestrel)).toBe(false);
  });

  it('is false for a client of another firm or no client at all, even firm-wide', async () => {
    const firmWide = systemContext(firmId, 'role-lookup-test');
    const otherClient = await t.db.withTenant(
      systemContext(otherFirmId, 'role-lookup-test'),
      async (tx) =>
        (await r.clients.create(tx, { name: 'Highmoor Mills', settings: DEFAULT_CLIENT_SETTINGS }))
          .id,
    );
    expect(await holds(firmWide, w.firmAdmin, ['FIRM_ADMIN'], otherClient)).toBe(false);
    expect(await holds(firmWide, w.firmAdmin, ['FIRM_ADMIN'], crypto.randomUUID())).toBe(false);
    // From the other firm, this firm's people hold nothing.
    const other = systemContext(otherFirmId, 'role-lookup-test');
    expect(await holds(other, w.firmAdmin, ['FIRM_ADMIN'], otherClient)).toBe(false);
    expect(await holds(other, w.otherFirmAdmin, ['FIRM_ADMIN'], otherClient)).toBe(true);
  });

  it('checks its input', async () => {
    const ask = (check: Record<string, unknown>) =>
      failure(
        t.db.withTenant(kestrelAdmin(), (tx: TenantTx) =>
          r.memberships.holdsRole(tx, check as unknown as r.RoleCheck),
        ),
      );
    const base = { personId: w.firmAdmin, roles: ['FIRM_ADMIN'], clientId: w.kestrel };
    expect(await ask({ ...base, roles: [] })).toBe('VALIDATION');
    expect(await ask({ ...base, roles: ['SUPERUSER'] })).toBe('VALIDATION');
    expect(await ask({ ...base, clientId: 'kestrel' })).toBe('VALIDATION');
    expect(await ask({ ...base, unitId: null })).toBe('VALIDATION');
    expect(await ask({ ...base, firmId: otherFirmId })).toBe('VALIDATION');
  });

  it('returns a boolean, runs for the app role and no other, and is owned by canopy_lookup', async () => {
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
      FROM pg_proc p WHERE p.proname = 'canopy_person_holds_role'`);
    expect(rows).toEqual([
      {
        result: 'boolean',
        definer: true,
        owner: 'canopy_lookup',
        config: ['search_path=public, pg_temp'],
        grantees: ['canopy_app', 'canopy_lookup'],
      },
    ]);
    const roles = await t.ownerQuery<{ role: string; can: boolean }>(`
      SELECT r AS role,
             has_function_privilege(r, 'canopy_person_holds_role(uuid, role[], uuid, uuid)', 'EXECUTE') AS can
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

  it('gives canopy_lookup the membership, client and unit columns it reads, and no whole table', async () => {
    const tables = await t.ownerQuery(`
      SELECT table_name FROM information_schema.role_table_grants
      WHERE grantee = 'canopy_lookup' AND table_name IN ('membership', 'client', 'unit')`);
    expect(tables.rows).toEqual([]);
    const columns = await t.ownerQuery<{ table: string; column: string }>(`
      SELECT table_name AS table, column_name AS column FROM information_schema.column_privileges
      WHERE grantee = 'canopy_lookup' AND table_name IN ('membership', 'client', 'unit')
      ORDER BY 1, 2`);
    expect(columns.rows.map((c) => `${c.table}.${c.column}`)).toEqual([
      'client.id',
      'membership.archived_at',
      'membership.client_id',
      'membership.consultant_client_ids',
      'membership.expires_at',
      'membership.firm_id',
      'membership.person_id',
      'membership.role',
      'membership.unit_ids',
      'unit.client_id',
      'unit.id',
    ]);
    const policies = await t.ownerQuery(`
      SELECT policyname, cmd, roles::text[] AS roles, qual FROM pg_policies
      WHERE tablename = 'membership' AND 'canopy_lookup' = ANY (roles)`);
    expect(policies.rows).toEqual([
      {
        policyname: 'role_lookup',
        cmd: 'SELECT',
        roles: ['canopy_lookup'],
        qual: '(firm_id = app_firm_id())',
      },
    ]);
  });
});
