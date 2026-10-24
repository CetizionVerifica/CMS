import { DEFAULT_CLIENT_SETTINGS } from '@canopy/contracts';
import { eq, inArray, sql, type Column } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Database, TenantTx } from '../../src/database.js';
import * as s from '../../src/schema/index.js';
import { systemContext } from '../../src/tenant-context.js';

/**
 * Writes at least one row to every table for one firm, through the app role, across two clients
 * plus firm-level rows (null client). Isolation tests assert on these rows table by table.
 */
export interface PopulatedFirm {
  firmId: string;
  clientIds: [string, string];
  /** Ids of the rows written, per table, for client 0, client 1 and firm level (null client). */
  rows: Record<string, { client0: string[]; client1: string[]; firmLevel: string[] }>;
}

const SHA = 'a'.repeat(64);

/**
 * INSERT naming only the given columns, returning the id. Drizzle's insert names every column the schema declares,
 * so tables that gained columns later (person.support, auth_*.support_grant_id, migration 0019) would fail in the
 * migrations test, which populates before those columns exist.
 */
async function insertNamed<T extends PgTable>(
  tx: TenantTx,
  table: T,
  values: Partial<T['$inferInsert']>,
): Promise<string> {
  const entries = Object.entries(values).filter(([, v]) => v !== undefined);
  const column = (key: string) => (table as unknown as Record<string, Column>)[key]!;
  const { rows } = await tx.execute<{ id: string }>(
    sql`INSERT INTO ${table} (${sql.join(
      entries.map(([k]) => sql.identifier(column(k).name)),
      sql`, `,
    )}) VALUES (${sql.join(
      entries.map(([k, v]) => sql.param(v, column(k))),
      sql`, `,
    )}) RETURNING id`,
  );
  if (!rows[0]) throw new Error('insert returned no row');
  return rows[0].id;
}

async function one<T extends { id: string }>(rows: Promise<T[]>): Promise<string> {
  const [row] = await rows;
  if (!row) throw new Error('insert returned no row');
  return row.id;
}

export async function populateFirm(
  db: Database,
  firmId: string,
  label: string,
): Promise<PopulatedFirm> {
  return db.withTenant(systemContext(firmId, `populate-${label}`), async (tx) => {
    const rows: PopulatedFirm['rows'] = {};
    const add = (table: string, scope: 'client0' | 'client1' | 'firmLevel', id: string) => {
      rows[table] ??= { client0: [], client1: [], firmLevel: [] };
      rows[table][scope].push(id);
    };
    add('firm', 'firmLevel', firmId);

    const locationId = await one(
      tx
        .insert(s.location)
        .values({
          country: 'India',
          countryCode: 'IN',
          state: 'West Bengal',
          stateCode: 'WB',
          city: `Riverbend ${label}`,
        })
        .returning({ id: s.location.id }),
    );
    add('location', 'firmLevel', locationId);

    const personIds: string[] = [];
    for (const role of ['owner', 'approver', 'admin']) {
      personIds.push(
        await insertNamed(tx, s.person, {
          displayName: `${label} ${role}`,
          nameNormalized: `${label} ${role}`.toLowerCase(),
          email: `${role}@${label}.example`,
          status: 'ACTIVE',
        }),
      );
    }
    const [ownerId, approverId, adminId] = personIds as [string, string, string];
    for (const id of personIds) add('person', 'firmLevel', id);

    add(
      'membership',
      'firmLevel',
      await one(
        tx
          .insert(s.membership)
          .values({ personId: adminId, role: 'FIRM_ADMIN' })
          .returning({ id: s.membership.id }),
      ),
    );

    const actId = await one(
      tx
        .insert(s.act)
        .values({ name: `Factories Act, 1948 (${label})`, jurisdiction: 'CENTRAL' })
        .returning({ id: s.act.id }),
    );
    add('act', 'firmLevel', actId);
    const categoryId = await one(
      tx
        .insert(s.category)
        .values({ name: `Returns ${label}` })
        .returning({ id: s.category.id }),
    );
    add('category', 'firmLevel', categoryId);
    const obligationId = await one(
      tx
        .insert(s.obligation)
        .values({
          externalRef: `HRS-CL-014-3059-${label}`,
          domain: 'HRS',
          jurisdiction: 'CENTRAL',
          actId,
          categoryId,
          title: 'Annual return',
          description: 'File the annual return.',
          criticality: 'HIGH',
          timelineType: 'TIME_BASED',
          recurrenceRule: { kind: 'ANNUAL', month: 1, day: 31 },
          ruleStatus: 'CONFIRMED',
        })
        .returning({ id: s.obligation.id }),
    );
    add('obligation', 'firmLevel', obligationId);

    add(
      'mapping_template',
      'firmLevel',
      await one(
        tx
          .insert(s.mappingTemplate)
          .values({ name: `Firm template ${label}`, mapping: [] })
          .returning({ id: s.mappingTemplate.id }),
      ),
    );
    add('audit_event', 'firmLevel', await audit(tx, null, adminId));
    add('domain_event', 'firmLevel', await event(tx, null, firmId));

    const clientIds: string[] = [];
    for (const scope of ['client0', 'client1'] as const) {
      const clientId = await one(
        tx
          .insert(s.client)
          .values({ name: `${label} ${scope} group`, settings: DEFAULT_CLIENT_SETTINGS })
          .returning({ id: s.client.id }),
      );
      clientIds.push(clientId);
      add('client', scope, clientId);
      await populateClient(tx, {
        clientId,
        scope,
        locationId,
        obligationId,
        ownerId,
        approverId,
        add,
      });
    }

    return { firmId, clientIds: clientIds as [string, string], rows };
  });
}

async function populateClient(
  tx: TenantTx,
  p: {
    clientId: string;
    scope: 'client0' | 'client1';
    locationId: string;
    obligationId: string;
    ownerId: string;
    approverId: string;
    add: (table: string, scope: 'client0' | 'client1', id: string) => void;
  },
): Promise<void> {
  const { clientId, scope, add } = p;
  const companyId = await one(
    tx
      .insert(s.company)
      .values({ clientId, name: 'Kestrel Aluminium' })
      .returning({ id: s.company.id }),
  );
  add('company', scope, companyId);
  const unitId = await one(
    tx
      .insert(s.unit)
      .values({ clientId, companyId, name: 'Plant', locationId: p.locationId })
      .returning({ id: s.unit.id }),
  );
  add('unit', scope, unitId);
  const departmentId = await one(
    tx
      .insert(s.department)
      .values({ clientId, name: 'Human Resources', aliases: ['HR'] })
      .returning({ id: s.department.id }),
  );
  add('department', scope, departmentId);
  add(
    'membership',
    scope,
    await one(
      tx
        .insert(s.membership)
        .values({ personId: p.ownerId, role: 'OWNER', clientId, unitIds: [unitId] })
        .returning({ id: s.membership.id }),
    ),
  );
  const assignmentId = await one(
    tx
      .insert(s.assignment)
      .values({
        clientId,
        unitId,
        obligationId: p.obligationId,
        departmentId,
        defaultOwnerId: p.ownerId,
        defaultApproverId: p.approverId,
        applicability: 'APPLICABLE',
        activeFrom: '2022-04-01',
      })
      .returning({ id: s.assignment.id }),
  );
  add('assignment', scope, assignmentId);
  const instanceId = await one(
    tx
      .insert(s.complianceInstance)
      .values({
        clientId,
        unitId,
        assignmentId,
        periodStart: '2022-04-01',
        periodEnd: '2023-03-31',
        dueDate: '2023-01-31',
        workflowState: 'APPROVED',
        completedOn: '2023-01-20',
        ownerId: p.ownerId,
        approverId: p.approverId,
        approvedAt: new Date('2023-01-21T05:00:00Z'),
      })
      .returning({ id: s.complianceInstance.id }),
  );
  add('compliance_instance', scope, instanceId);
  add(
    'evidence',
    scope,
    await one(
      tx
        .insert(s.evidence)
        .values({
          instanceId,
          clientId,
          fileName: 'return.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          sha256: SHA,
          storageKey: `evidence/${instanceId}/return.pdf`,
          uploadedById: p.ownerId,
        })
        .returning({ id: s.evidence.id }),
    ),
  );
  add(
    'comment',
    scope,
    await one(
      tx
        .insert(s.comment)
        .values({ instanceId, clientId, authorId: p.ownerId, kind: 'SUBMIT', body: 'Filed.' })
        .returning({ id: s.comment.id }),
    ),
  );
  add('audit_event', scope, await audit(tx, clientId, p.ownerId));
  add('domain_event', scope, await event(tx, clientId, instanceId));
  const templateId = await one(
    tx
      .insert(s.mappingTemplate)
      .values({ clientId, name: 'Register', mapping: [{ sourceHeader: 'Title', field: 'title' }] })
      .returning({ id: s.mappingTemplate.id }),
  );
  add('mapping_template', scope, templateId);
  const batchId = await one(
    tx
      .insert(s.importBatch)
      .values({
        clientId,
        createdById: p.ownerId,
        fileName: 'register.xlsx',
        fileSha256: SHA,
        mappingTemplateId: templateId,
      })
      .returning({ id: s.importBatch.id }),
  );
  add('import_batch', scope, batchId);
  const issueId = await one(
    tx
      .insert(s.importIssue)
      .values({
        clientId,
        batchId,
        groupKey: 'ALIAS_DEPARTMENT:Human Resources',
        type: 'ALIAS_DEPARTMENT',
        severity: 'WARNING',
        rowNumbers: [2],
        field: 'department',
        rawValues: ['HR', 'Human Resources'],
        proposal: 'Human Resources',
      })
      .returning({ id: s.importIssue.id }),
  );
  add('import_issue', scope, issueId);
  add(
    'import_row',
    scope,
    await one(
      tx
        .insert(s.importRow)
        .values({
          clientId,
          batchId,
          rowNumber: 2,
          raw: { Title: 'Annual return', Department: 'HR' },
          mapped: { title: 'Annual return', department: 'Human Resources' },
          issueIds: [issueId],
          targetInstanceId: instanceId,
        })
        .returning({ id: s.importRow.id }),
    ),
  );
  add(
    'export_job',
    scope,
    await one(
      tx
        .insert(s.exportJob)
        .values({ clientId, kind: 'REGISTER_XLSX', requestedById: p.ownerId })
        .returning({ id: s.exportJob.id }),
    ),
  );
  add(
    'notification_send',
    scope,
    // Raw SQL naming its columns: the migration test runs this at migration 0002, before later
    // columns (event_id, 0016) exist, and Drizzle's insert lists every schema column.
    (
      await tx.execute<{ id: string }>(sql`
        INSERT INTO notification_send (client_id, instance_id, recipient_id, kind, send_date)
        VALUES (${clientId}, ${instanceId}, ${p.ownerId}, 'OWNER_REMINDER', '2023-01-24')
        RETURNING id`)
    ).rows[0]!.id,
  );
}

function audit(tx: TenantTx, clientId: string | null, actorId: string): Promise<string> {
  return one(
    tx
      .insert(s.auditEvent)
      .values({
        clientId,
        requestId: 'populate',
        actorId,
        actorKind: 'PERSON',
        action: clientId ? 'TRANSITION' : 'LOGIN',
        entityType: clientId ? 'client' : 'person',
        entityId: clientId ?? actorId,
        after: { workflowState: 'APPROVED' },
      })
      .returning({ id: s.auditEvent.id }),
  );
}

function event(tx: TenantTx, clientId: string | null, aggregateId: string): Promise<string> {
  return one(
    tx
      .insert(s.domainEvent)
      .values({
        clientId,
        type: clientId ? 'instance.approved' : 'client.created',
        actor: { kind: 'SYSTEM', job: 'populate' },
        requestId: 'populate',
        aggregateType: clientId ? 'instance' : 'firm',
        aggregateId,
        aggregateVersion: 1,
        data: {},
      })
      .returning({ id: s.domainEvent.id }),
  );
}

/**
 * Sign-in rows (migrations 0011-0012) for a firm `populateFirm` wrote: a credential and a session for the
 * admin, an invite per client and one firm-level invite, and a magic link plus a link per invite. Added to
 * `firm.rows`. Separate from populateFirm because the migration test populates before these tables exist.
 */
export async function populateAuth(
  db: Database,
  firm: PopulatedFirm,
  label: string,
): Promise<void> {
  await db.withTenant(systemContext(firm.firmId, `populate-auth-${label}`), async (tx) => {
    const add = (table: string, scope: 'client0' | 'client1' | 'firmLevel', id: string) => {
      firm.rows[table] ??= { client0: [], client1: [], firmLevel: [] };
      firm.rows[table][scope].push(id);
    };
    const byEmail = async (email: string) => {
      const [row] = await tx
        .select({ id: s.person.id })
        .from(s.person)
        .where(eq(s.person.email, email));
      if (!row) throw new Error(`no person ${email}`);
      return row.id;
    };
    const adminId = await byEmail(`admin@${label}.example`);
    const ownerId = await byEmail(`owner@${label}.example`);
    const hash = (n: number) => `${label === 'a' ? 'a' : 'b'}${n}`.padEnd(64, '0');
    const later = new Date('2030-01-01T00:00:00Z');

    add(
      'auth_credential',
      'firmLevel',
      await one(
        tx
          .insert(s.authCredential)
          .values({ personId: adminId, passwordHash: 'scrypt$32768$8$1$salt$populate' })
          .returning({ id: s.authCredential.id }),
      ),
    );
    add(
      'auth_session',
      'firmLevel',
      await insertNamed(tx, s.authSession, {
        personId: adminId,
        tokenHash: hash(1),
        csrfToken: 'c'.repeat(43),
        method: 'PASSWORD',
        expiresAt: later,
      }),
    );
    const invite = (clientId: string | null) =>
      one(
        tx
          .insert(s.authInvite)
          .values({
            personId: ownerId,
            email: `owner@${label}.example`,
            role: clientId ? 'OWNER' : 'FIRM_ADMIN',
            clientId,
            createdById: adminId,
            expiresAt: later,
          })
          .returning({ id: s.authInvite.id }),
      );
    const inviteIds = [
      await invite(firm.clientIds[0]),
      await invite(firm.clientIds[1]),
      await invite(null),
    ];
    add('auth_invite', 'client0', inviteIds[0]!);
    add('auth_invite', 'client1', inviteIds[1]!);
    add('auth_invite', 'firmLevel', inviteIds[2]!);
    const token = (n: number, inviteId: string | null) =>
      insertNamed(tx, s.authToken, {
        personId: ownerId,
        kind: inviteId ? 'INVITE' : 'MAGIC_LINK',
        inviteId,
        tokenHash: hash(n),
        expiresAt: later,
      });
    add('auth_token', 'firmLevel', await token(2, null));
    for (const [i, id] of inviteIds.entries())
      add('auth_token', 'firmLevel', await token(3 + i, id));
  });
}

/** Idempotency keys (migration 0014), one per firm admin and owner; written after populateAuth. */
export async function populateIdempotency(
  db: Database,
  firm: PopulatedFirm,
  label: string,
): Promise<void> {
  await db.withTenant(systemContext(firm.firmId, `populate-idempotency-${label}`), async (tx) => {
    firm.rows['idempotency_key'] ??= { client0: [], client1: [], firmLevel: [] };
    const people = await tx
      .select({ id: s.person.id })
      .from(s.person)
      .where(inArray(s.person.email, [`admin@${label}.example`, `owner@${label}.example`]));
    for (const [i, { id }] of people.entries()) {
      firm.rows['idempotency_key'].firmLevel.push(
        await one(
          tx
            .insert(s.idempotencyKey)
            .values({
              personId: id,
              key: `populate-${label}-${i}`,
              method: 'POST',
              path: '/v1/instances/submit',
              requestHash: 'f'.repeat(64),
              responseStatus: 200,
              responseBody: { ok: true },
              createdAt: new Date('2029-12-31T00:00:00Z'),
              expiresAt: new Date('2030-01-01T00:00:00Z'),
            })
            .returning({ id: s.idempotencyKey.id }),
        ),
      );
    }
  });
}

/**
 * PlanetPulse support access (migrations 0019-0020): the support person, one live grant and a one-time SUPPORT
 * token for it. Added to `firm.rows`; written after populateAuth.
 */
export async function populateSupport(
  db: Database,
  firm: PopulatedFirm,
  label: string,
): Promise<void> {
  await db.withTenant(systemContext(firm.firmId, `populate-support-${label}`), async (tx) => {
    const add = (table: string, id: string) => {
      firm.rows[table] ??= { client0: [], client1: [], firmLevel: [] };
      firm.rows[table].firmLevel.push(id);
    };
    const [admin] = await tx
      .select({ id: s.person.id })
      .from(s.person)
      .where(eq(s.person.email, `admin@${label}.example`));
    if (!admin) throw new Error(`no admin for ${label}`);
    const supportId = await one(
      tx
        .insert(s.person)
        .values({
          displayName: 'PlanetPulse support',
          nameNormalized: 'planetpulse support',
          email: 'support@planetpulse.life',
          status: 'ACTIVE',
          support: true,
        })
        .returning({ id: s.person.id }),
    );
    add('person', supportId);
    const grantId = await one(
      tx
        .insert(s.supportGrant)
        .values({
          level: 'READ_ONLY',
          startsAt: new Date('2029-12-25T00:00:00Z'),
          endsAt: new Date('2030-01-01T00:00:00Z'),
          grantedById: admin.id,
          supportPersonId: supportId,
        })
        .returning({ id: s.supportGrant.id }),
    );
    add('support_grant', grantId);
    add(
      'auth_token',
      await one(
        tx
          .insert(s.authToken)
          .values({
            personId: supportId,
            kind: 'SUPPORT',
            supportGrantId: grantId,
            tokenHash: `${label === 'a' ? 'a' : 'b'}9`.padEnd(64, '0'),
            expiresAt: new Date('2030-01-01T00:00:00Z'),
          })
          .returning({ id: s.authToken.id }),
      ),
    );
  });
}
