import { Id } from '@canopy/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantTx } from '../src/database.js';
import * as s from '../src/schema/index.js';
import { systemContext, type TenantContext } from '../src/tenant-context.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import {
  populateAuth,
  populateFirm,
  populateIdempotency,
  populateIso,
  populateSupport,
  type PopulatedFirm,
} from './support/populate.js';
import { clientColumn, TABLES, tenantColumn } from './support/tables.js';

/**
 * Tenant isolation, table by table (root CLAUDE.md non-negotiable 1, packages/db/CLAUDE.md rule 3,
 * fixtures.md §5 M3): two firms, each with rows in every table, seen through the app role.
 */

let t: TestDatabase;
let a: PopulatedFirm;
let b: PopulatedFirm;

beforeAll(async () => {
  t = await createTestDatabase();
  const firmA = await t.admin.createFirm({ name: 'Demo Advisory' });
  const firmB = await t.admin.createFirm({ name: 'Second Ledger Consulting' });
  a = await populateFirm(t.db, firmA, 'a');
  b = await populateFirm(t.db, firmB, 'b');
  await populateAuth(t.db, a, 'a');
  await populateAuth(t.db, b, 'b');
  await populateIdempotency(t.db, a, 'a');
  await populateIdempotency(t.db, b, 'b');
  await populateSupport(t.db, a, 'a');
  await populateSupport(t.db, b, 'b');
  await populateIso(t.db, a, 'a');
  await populateIso(t.db, b, 'b');
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

const asFirm = (firm: PopulatedFirm): TenantContext => systemContext(firm.firmId, 'isolation-test');

function ids(firm: PopulatedFirm, table: string): string[] {
  const r = firm.rows[table];
  return r ? [...r.client0, ...r.client1, ...r.firmLevel] : [];
}

async function count(tx: TenantTx, table: string, where = 'true') {
  const query = sql.raw(`SELECT count(*)::int AS n FROM "${table}" WHERE ${where}`);
  const result = await tx.execute<{ n: number }>(query);
  return result.rows[0]!.n;
}

/** An UPDATE that changes nothing; on firm, a column the app role may update (migration 0020). */
function noop(table: string): string {
  // Tables whose app UPDATE grant is column-limited touch a column the app may write.
  if (table === 'firm') return 'name = name';
  if (table === 'support_grant') return 'updated_at = updated_at';
  return 'id = id';
}

function errorCode(error: unknown): string | undefined {
  let e: unknown = error;
  while (e && typeof e === 'object') {
    if ('code' in e && typeof e.code === 'string') return e.code;
    e = 'cause' in e ? e.cause : undefined;
  }
  return undefined;
}

describe('fixture', () => {
  it.each(TABLES.map((x) => x.name))('%s has rows for both firms', async (table) => {
    expect(ids(a, table).length, `populateFirm writes no ${table} rows`).toBeGreaterThan(0);
    for (const firm of [a, b]) {
      const { rows } = await t.ownerQuery<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${table}" WHERE ${tenantColumn(table)} = $1`,
        [firm.firmId],
      );
      expect(rows[0]!.n).toBe(ids(firm, table).length);
    }
  });
});

describe.each(TABLES.map((x) => x.name))('%s', (table) => {
  const col = tenantColumn(table);

  it('firm B sees no rows of firm A, and all of its own', async () => {
    await t.db.withTenant(asFirm(b), async (tx) => {
      expect(await count(tx, table, `${col} = '${a.firmId}'`)).toBe(0);
      expect(await count(tx, table)).toBe(ids(b, table).length);
    });
  });

  it('firm B cannot update rows of firm A', async () => {
    const target = `{${ids(a, table).join(',')}}`;
    const update = sql.raw(
      `UPDATE "${table}" SET ${noop(table)} WHERE id = ANY ('${target}'::uuid[])`,
    );
    if (table === 'audit_event') {
      // Not even its own: the app role has no UPDATE on the audit trail.
      await expect(t.db.withTenant(asFirm(b), (tx) => tx.execute(update))).rejects.toSatisfy(
        (e) => errorCode(e) === '42501',
      );
      return;
    }
    const result = await t.db.withTenant(asFirm(b), (tx) => tx.execute(update));
    expect(result.rowCount).toBe(0);
  });

  it('firm B cannot insert a row carrying firm A', async () => {
    const { rows } = await t.ownerQuery<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(x) AS row FROM "${table}" x WHERE id = $1`,
      [ids(a, table)[0]],
    );
    const copy = JSON.stringify({ ...rows[0]!.row, id: '01920000-0000-7000-8000-000000000001' });
    const insert = sql`INSERT INTO ${sql.identifier(table)} SELECT * FROM jsonb_populate_record(null::${sql.identifier(table)}, ${copy}::jsonb)`;
    const error = await t.db.withTenant(asFirm(b), (tx) => tx.execute(insert)).catch((e) => e);
    expect(errorCode(error)).toBe('42501');
    // firm rows are never inserted by the app role; everywhere else the RLS policy is what refuses.
    expect(String(error.cause ?? error)).toMatch(
      table === 'firm' ? /permission denied/ : /row-level security/,
    );
  });

  it('the app role cannot delete, not even its own rows', async () => {
    if (table === 'import_issue' || table === 'idempotency_key') {
      // The deletable tables (migrations 0009, 0015): RLS still limits DELETE to the firm.
      const other = sql.raw(`DELETE FROM "${table}" WHERE ${col} = '${a.firmId}'`);
      const result = await t.db.withTenant(asFirm(b), (tx) => tx.execute(other));
      expect(result.rowCount).toBe(0);
      return;
    }
    const del = sql.raw(`DELETE FROM "${table}" WHERE ${col} = '${b.firmId}'`);
    await expect(t.db.withTenant(asFirm(b), (tx) => tx.execute(del))).rejects.toSatisfy(
      (e) => errorCode(e) === '42501',
    );
  });

  it('the app role without a tenant context sees nothing', async () => {
    const n = await t.ownerTransaction(async (client) => {
      await client.query('SET LOCAL ROLE canopy_app');
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${table}"`,
      );
      return rows[0]!.n;
    });
    expect(n).toBe(0);
  });
});

describe('client scope within a firm', () => {
  const clientScoped = TABLES.map((x) => x.name).filter((name) => clientColumn(name) !== null);
  const asClient0 = (personId: string | null = null): TenantContext => ({
    firmId: a.firmId,
    personId,
    clientIds: [a.clientIds[0]],
    requestId: 'isolation-test',
  });

  it.each(clientScoped)('%s: a client-scoped context sees only its client', async (table) => {
    await t.db.withTenant(asClient0(), async (tx) => {
      const col = clientColumn(table)!;
      expect(await count(tx, table, `${col} = '${a.clientIds[1]}'`)).toBe(0);
      expect(await count(tx, table, `${col} IS NULL`)).toBe(0);
      expect(await count(tx, table)).toBe(a.rows[table]!.client0.length);
    });
  });

  it.each(clientScoped)(
    '%s: a client-scoped context cannot write another client',
    async (table) => {
      const target = `{${a.rows[table]!.client1.join(',')}}`;
      if (table === 'audit_event') return; // no UPDATE at all; covered above
      const result = await t.db.withTenant(asClient0(), (tx) =>
        tx.execute(
          sql.raw(`UPDATE "${table}" SET ${noop(table)} WHERE id = ANY ('${target}'::uuid[])`),
        ),
      );
      expect(result.rowCount).toBe(0);
    },
  );

  it('firm-wide tables stay readable by client users', async () => {
    await t.db.withTenant(asClient0(), async (tx) => {
      for (const table of ['firm', 'location', 'act', 'category', 'obligation']) {
        expect(await count(tx, table), table).toBe(ids(a, table).length);
      }
    });
  });

  it.each(['firm', 'location', 'act', 'category', 'obligation'])(
    '%s: client users cannot change firm-wide rows',
    async (table) => {
      const result = await t.db.withTenant(asClient0(), (tx) =>
        tx.execute(sql.raw(`UPDATE "${table}" SET ${noop(table)}`)),
      );
      expect(result.rowCount).toBe(0);
    },
  );

  it('client users may add a location but not library rows', async () => {
    await t.db.withTenant(asClient0(), (tx) =>
      tx
        .insert(s.location)
        .values({ country: 'India', countryCode: 'IN', state: 'Kerala', stateCode: 'KL' }),
    );
    const error = await t.db
      .withTenant(asClient0(), (tx) => tx.insert(s.category).values({ name: 'Client-made' }))
      .catch((e) => e);
    expect(errorCode(error)).toBe('42501');
  });

  it('firm staff limited to some clients (consultants) may change the library', async () => {
    const result = await t.db.withTenant({ ...asClient0(), firmStaff: true }, (tx) =>
      tx.execute(sql`UPDATE act SET aliases = '{}' WHERE firm_id = ${a.firmId}`),
    );
    expect(result.rowCount).toBe(ids(a, 'act').length);
  });

  it('client users see only the people of their clients, and themselves', async () => {
    const [ownerId, approverId, adminId] = ids(a, 'person') as [string, string, string];
    const visible = async (personId: string | null) =>
      t.db.withTenant(asClient0(personId), async (tx) =>
        (await tx.select({ id: s.person.id }).from(s.person)).map((p) => p.id).sort(),
      );
    expect(await visible(null)).toEqual([ownerId, approverId].sort());
    expect(await visible(adminId)).toEqual([ownerId, approverId, adminId].sort());
    const none = await t.db.withTenant({ ...asClient0(), clientIds: [] }, (tx) =>
      tx.select({ id: s.person.id }).from(s.person),
    );
    expect(none).toEqual([]);
  });

  it('client users cannot change people holding a firm role, even ones they can see', async () => {
    const adminId = ids(a, 'person')[2]!;
    // Give the firm admin a membership in client 0, so client 0 can see them.
    const membershipId = await t.db.withTenant(asFirm(a), async (tx) => {
      const [m] = await tx
        .insert(s.membership)
        .values({ personId: adminId, role: 'APPROVER', clientId: a.clientIds[0] })
        .returning({ id: s.membership.id });
      return m!.id;
    });
    try {
      await t.db.withTenant(asClient0(), async (tx) => {
        const seen = await tx
          .select({ id: s.person.id })
          .from(s.person)
          .where(sql`id = ${adminId}`);
        expect(seen).toHaveLength(1);
        const admin = await tx.execute(
          sql`UPDATE person SET email = 'evil@example.com' WHERE id = ${adminId}`,
        );
        expect(admin.rowCount).toBe(0);
      });
    } finally {
      await t.db.withTenant(asFirm(a), (tx) =>
        tx.execute(sql`UPDATE membership SET archived_at = now() WHERE id = ${membershipId}`),
      );
    }
  });

  it('client users cannot change a person who also works for a client they cannot see', async () => {
    // The fixture owner has memberships in both clients (re-audit finding A on PR #16).
    const ownerId = ids(a, 'person')[0]!;
    const touch = (ctx: TenantContext) =>
      t.db.withTenant(ctx, (tx) =>
        tx.execute(sql`UPDATE person SET email = 'evil@example.com' WHERE id = ${ownerId}`),
      );
    await t.db.withTenant(asClient0(), async (tx) => {
      const seen = await tx
        .select({ id: s.person.id })
        .from(s.person)
        .where(sql`id = ${ownerId}`);
      expect(seen).toHaveLength(1);
    });
    expect((await touch(asClient0())).rowCount).toBe(0);
    expect((await touch(asClient0(ownerId))).rowCount).toBe(0);
    // A context that sees both of the owner's clients may change them.
    const both = { ...asClient0(), clientIds: [...a.clientIds] };
    const allowed = await t.db.withTenant(both, (tx) =>
      tx.execute(sql`UPDATE person SET display_name = display_name WHERE id = ${ownerId}`),
    );
    expect(allowed.rowCount).toBe(1);
  });

  it('client users can change a person who works only for their clients', async () => {
    const result = await t.db.withTenant(asClient0(), async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`SELECT canopy_uuid_v7() AS id`);
      const id = rows[0]!.id;
      await tx.insert(s.person).values({
        id,
        displayName: 'Client Zero Only',
        nameNormalized: 'client zero only',
        email: null,
        status: 'UNCLAIMED',
      });
      await tx
        .insert(s.membership)
        .values({ personId: id, role: 'OWNER', clientId: a.clientIds[0] });
      return tx.execute(sql`UPDATE person SET display_name = 'Renamed' WHERE id = ${id}`);
    });
    expect(result.rowCount).toBe(1);
  });

  it('a client user can create a person and their membership, then see them', async () => {
    const created = await t.db.withTenant(asClient0(), async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`SELECT canopy_uuid_v7() AS id`);
      const id = rows[0]!.id;
      // No RETURNING: the new person is not visible until their membership exists.
      await tx.insert(s.person).values({
        id,
        displayName: 'New Owner',
        nameNormalized: 'new owner',
        email: null,
        status: 'UNCLAIMED',
      });
      await tx
        .insert(s.membership)
        .values({ personId: id, role: 'OWNER', clientId: a.clientIds[0] });
      return tx
        .select({ id: s.person.id })
        .from(s.person)
        .where(sql`id = ${id}`);
    });
    expect(created).toHaveLength(1);
  });

  it('a context with no clients sees no client rows', async () => {
    await t.db.withTenant({ ...asClient0(), clientIds: [] }, async (tx) => {
      for (const table of clientScoped) expect(await count(tx, table), table).toBe(0);
    });
  });

  it('a person always sees their own memberships, including firm-level ones', async () => {
    const [adminMembership] = await t
      .ownerQuery<{ person_id: string }>('SELECT person_id FROM membership WHERE id = $1', [
        a.rows.membership!.firmLevel[0],
      ])
      .then((r) => r.rows);
    await t.db.withTenant(
      { ...asClient0(adminMembership!.person_id), clientIds: [] },
      async (tx) => {
        const rows = await tx.select().from(s.membership);
        expect(rows.filter((m) => m.archivedAt === null).map((m) => m.role)).toEqual([
          'FIRM_ADMIN',
        ]);
      },
    );
  });

  it('a client user may write audit and outbox rows with no client, but not read them back', async () => {
    await t.db.withTenant(asClient0(), async (tx) => {
      await tx.insert(s.auditEvent).values({
        requestId: 'login',
        actorKind: 'SYSTEM',
        action: 'LOGIN',
        entityType: 'person',
        entityId: ids(a, 'person')[0]!,
      });
      expect(await count(tx, 'audit_event', 'client_id IS NULL')).toBe(0);
    });
  });

  it('a client user cannot create firm-level memberships or templates', async () => {
    const personId = ids(a, 'person')[0]!;
    await expect(
      t.db.withTenant(asClient0(), (tx) =>
        tx.insert(s.membership).values({ personId, role: 'FIRM_ADMIN' }),
      ),
    ).rejects.toSatisfy((e) => errorCode(e) === '42501');
    await expect(
      t.db.withTenant(asClient0(), (tx) =>
        tx.insert(s.mappingTemplate).values({ name: 'Firm-wide', mapping: [] }),
      ),
    ).rejects.toSatisfy((e) => errorCode(e) === '42501');
  });
});

describe('references cannot cross firms', () => {
  // Composite foreign keys on (firm_id, ...) stop a row in firm B pointing at a parent in firm A,
  // even when the parent's id is known. RLS alone would not: foreign key checks bypass it.
  async function rowOf(table: string, id: string): Promise<Record<string, unknown>> {
    const { rows } = await t.ownerQuery<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(x) AS row FROM "${table}" x WHERE id = $1`,
      [id],
    );
    return rows[0]!.row;
  }

  const cases: [table: string, column: string, parent: string][] = [
    ['unit', 'location_id', 'location'],
    ['membership', 'person_id', 'person'],
    ['obligation', 'act_id', 'act'],
    ['assignment', 'obligation_id', 'obligation'],
    ['assignment', 'default_owner_id', 'person'],
    ['compliance_instance', 'approver_id', 'person'],
    ['evidence', 'uploaded_by_id', 'person'],
    ['export_job', 'requested_by_id', 'person'],
    ['iso_clause', 'standard_id', 'iso_standard'],
    ['clause_assessment', 'clause_id', 'iso_clause'],
    ['certification', 'standard_id', 'iso_standard'],
    ['controlled_document', 'approver_id', 'person'],
  ];

  it.each(cases)('%s.%s cannot point at firm A’s %s', async (table, column, parent) => {
    const own = await rowOf(table, b.rows[table]!.client0[0] ?? b.rows[table]!.firmLevel[0]!);
    const copy = {
      ...own,
      id: '01920000-0000-7000-8000-000000000002',
      [column]: ids(a, parent)[0],
      // Step around unique keys so the foreign key is what rejects the row.
      archived_at: '2026-01-01T00:00:00Z',
      ...(table === 'evidence' ? { storage_key: 'evidence/copy' } : {}),
      ...(table === 'compliance_instance' ? { period_start: '2021-04-01' } : {}),
    };
    const insert = sql`INSERT INTO ${sql.identifier(table)} SELECT * FROM jsonb_populate_record(null::${sql.identifier(table)}, ${JSON.stringify(copy)}::jsonb)`;
    await expect(t.db.withTenant(asFirm(b), (tx) => tx.execute(insert))).rejects.toSatisfy(
      (e) => errorCode(e) === '23503',
    );
  });

  it('an instance cannot claim a client or unit other than its assignment’s', async () => {
    const own = await rowOf('compliance_instance', b.rows.compliance_instance!.client0[0]!);
    const copy = {
      ...own,
      id: '01920000-0000-7000-8000-000000000003',
      client_id: b.clientIds[1],
      period_start: '2021-04-01',
    };
    const insert = sql`INSERT INTO compliance_instance SELECT * FROM jsonb_populate_record(null::compliance_instance, ${JSON.stringify(copy)}::jsonb)`;
    await expect(t.db.withTenant(asFirm(b), (tx) => tx.execute(insert))).rejects.toSatisfy(
      (e) => errorCode(e) === '23503',
    );
  });
});

describe('audit trail is append-only', () => {
  const auditId = () => a.rows.audit_event!.client0[0]!;

  it('the app role cannot update or delete audit rows', async () => {
    for (const statement of [
      `UPDATE audit_event SET reason = 'edited' WHERE id = '${auditId()}'`,
      `DELETE FROM audit_event WHERE id = '${auditId()}'`,
    ]) {
      await expect(
        t.db.withTenant(asFirm(a), (tx) => tx.execute(sql.raw(statement))),
      ).rejects.toSatisfy((e) => errorCode(e) === '42501');
    }
  });

  it('the owner cannot update, delete or truncate audit rows either', async () => {
    for (const statement of [
      `UPDATE audit_event SET reason = 'edited' WHERE id = '${auditId()}'`,
      `DELETE FROM audit_event WHERE id = '${auditId()}'`,
      'TRUNCATE audit_event',
    ]) {
      await expect(t.ownerQuery(statement)).rejects.toThrow(/append-only/);
    }
    const { rows } = await t.ownerQuery('SELECT reason FROM audit_event WHERE id = $1', [
      auditId(),
    ]);
    expect(rows).toEqual([{ reason: null }]);
  });
});

describe('defaults and types', () => {
  it('fills firm_id from the context and generates UUIDv7 ids', async () => {
    await t.db.withTenant(asFirm(a), async (tx) => {
      const [row] = await tx.insert(s.category).values({ name: 'Defaults check' }).returning();
      expect(row!.firmId).toBe(a.firmId);
      expect(Id.parse(row!.id)).toBe(row!.id);
      expect(row!.id[14]).toBe('7');
      expect(row!.version).toBe(1);
      expect(row!.createdAt).toBeInstanceOf(Date);
    });
  });

  it('reads dates as YYYY-MM-DD strings, never shifted by a time zone', async () => {
    await t.db.withTenant(asFirm(a), async (tx) => {
      await tx.execute(sql`SET LOCAL TIME ZONE 'Asia/Kolkata'`);
      const [row] = await tx
        .select({
          dueDate: s.complianceInstance.dueDate,
          approvedAt: s.complianceInstance.approvedAt,
        })
        .from(s.complianceInstance)
        .where(sql`id = ${a.rows.compliance_instance!.client0[0]}`);
      expect(row).toEqual({ dueDate: '2023-01-31', approvedAt: new Date('2023-01-21T05:00:00Z') });
    });
  });

  it('bumps updated_at on update', async () => {
    const id = a.rows.department!.client0[0]!;
    const before = await t.ownerQuery<{ updated_at: Date }>(
      'SELECT updated_at FROM department WHERE id = $1',
      [id],
    );
    await t.db.withTenant(asFirm(a), (tx) =>
      tx.execute(sql`UPDATE department SET aliases = '{HR,H.R.}' WHERE id = ${id}`),
    );
    const after = await t.ownerQuery<{ updated_at: Date }>(
      'SELECT updated_at FROM department WHERE id = $1',
      [id],
    );
    expect(after.rows[0]!.updated_at.getTime()).toBeGreaterThan(
      before.rows[0]!.updated_at.getTime(),
    );
  });

  it('rejects a malformed tenant context before touching the database', async () => {
    await expect(
      t.db.withTenant({ ...asFirm(a), firmId: "x' or true" }, async () => 1),
    ).rejects.toThrow();
  });

  it('creates a firm with a generated id and default settings', async () => {
    const id = await t.admin.createFirm({ name: 'Third Firm' });
    expect(id[14]).toBe('7');
    const { rows } = await t.ownerQuery<{ settings: unknown }>(
      'SELECT settings FROM firm WHERE id = $1',
      [id],
    );
    expect(rows[0]!.settings).toMatchObject({ dueSoonDays: 7, mfaRequiredForFirmRoles: true });
  });
});
