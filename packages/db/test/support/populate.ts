import { DEFAULT_CLIENT_SETTINGS } from '@canopy/contracts';
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
          city: `Belur ${label}`,
        })
        .returning({ id: s.location.id }),
    );
    add('location', 'firmLevel', locationId);

    const personIds: string[] = [];
    for (const role of ['owner', 'approver', 'admin']) {
      personIds.push(
        await one(
          tx
            .insert(s.person)
            .values({
              displayName: `${label} ${role}`,
              nameNormalized: `${label} ${role}`.toLowerCase(),
              email: `${role}@${label}.example`,
              status: 'ACTIVE',
            })
            .returning({ id: s.person.id }),
        ),
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
    tx.insert(s.company).values({ clientId, name: 'Hindalco' }).returning({ id: s.company.id }),
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
    await one(
      tx
        .insert(s.notificationSend)
        .values({
          clientId,
          instanceId,
          recipientId: p.ownerId,
          kind: 'OWNER_REMINDER',
          sendDate: '2023-01-24',
        })
        .returning({ id: s.notificationSend.id }),
    ),
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
