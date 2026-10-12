import { DEFAULT_CLIENT_SETTINGS } from '@canopy/contracts';
import {
  acts,
  assignments,
  categories,
  clients,
  companies,
  departments,
  instances,
  locations,
  memberships,
  obligations,
  people,
  systemContext,
  units,
  type TenantTx,
} from '@canopy/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runConsultantDigest } from './digest.js';
import { runGenerateInstances } from './generate-instances.js';
import type { JobDeps } from './ports.js';
import { postgresJobStore } from './postgres-store.js';
import { runReminders } from './reminders.js';
import { APP_URL } from './testing/builders.js';
import { captureMailer, type CaptureMailer } from './testing/memory-store.js';
import { createJobTestDatabase, type JobTestDatabase } from './testing/postgres.js';

// The three jobs end to end on M3's repositories and RLS, against Postgres 16 (CI `db` job). Skipped without
// DATABASE_URL (the unit run). 2026-10-12 is a Monday, the default digest day; 01:30Z is 07:00 in Asia/Kolkata.
const url = process.env.DATABASE_URL;

describe.skipIf(!url)('jobs on the Postgres store', () => {
  let t: JobTestDatabase;
  let firmA: string;
  let firmB: string;
  let mailer: CaptureMailer;
  let now = '2026-10-12T01:30:00.000Z';
  let deps: JobDeps;
  const w = {} as {
    clientId: string;
    assignmentId: string;
    ownerId: string;
    approverId: string;
    consultantId: string;
    reminded: string;
    escalated: string;
  };

  const inFirm = <T>(firmId: string, fn: (tx: TenantTx) => Promise<T>) =>
    t.db.withTenant(systemContext(firmId, 'jobs-db-test'), fn);

  function instance(dueDate: string, state: 'OPEN' | 'SUBMITTED' | 'APPROVED') {
    return {
      clientId: w.clientId,
      unitId: unitId,
      assignmentId: w.assignmentId,
      // A one-day period on the due date never collides with the generated months, which start on the 1st.
      periodStart: dueDate,
      periodEnd: dueDate,
      dueDate,
      workflowState: state,
      pendingKind: state === 'SUBMITTED' ? 'COMPLETION' : null,
      completedOn: state === 'OPEN' ? null : '2026-10-01',
      naReason: null,
      ownerId: w.ownerId,
      approverId: w.approverId,
      submittedAt: null,
      approvedAt: null,
      dueDateOverridden: false,
    } as unknown as Parameters<typeof instances.create>[1];
  }
  let unitId: string;

  beforeAll(async () => {
    t = await createJobTestDatabase(url!);
    firmA = await t.admin.createFirm({ name: 'Demo Advisory' });
    firmB = await t.admin.createFirm({ name: 'Second Ledger Consulting' });
    await inFirm(firmA, async (tx) => {
      const client = await clients.create(tx, {
        name: 'Aditya Birla Group',
        settings: DEFAULT_CLIENT_SETTINGS,
      });
      const company = await companies.create(tx, { clientId: client.id, name: 'Hindalco' });
      const location = await locations.create(tx, {
        country: 'India',
        countryCode: 'IN',
        state: 'West Bengal',
        stateCode: 'WB',
        city: 'Belur',
      });
      const unit = await units.create(tx, {
        clientId: client.id,
        companyId: company.id,
        name: 'Belur Plant',
        locationId: location.id,
      });
      const department = await departments.create(tx, {
        clientId: client.id,
        name: 'Finance',
        aliases: [],
      });
      const owner = await people.create(tx, {
        displayName: 'Owner 01',
        nameNormalized: 'owner 01',
        email: 'owner01@example.com',
        status: 'ACTIVE',
      });
      const approver = await people.create(tx, {
        displayName: 'Approver 01',
        nameNormalized: 'approver 01',
        email: null,
        status: 'UNCLAIMED',
      });
      const consultant = await people.create(tx, {
        displayName: 'Consultant 01',
        nameNormalized: 'consultant 01',
        email: 'consultant01@example.com',
        status: 'ACTIVE',
      });
      for (const [personId, role] of [
        [owner.id, 'OWNER'],
        [approver.id, 'APPROVER'],
      ] as const) {
        await memberships.create(tx, {
          personId,
          role,
          clientId: client.id,
          consultantClientIds: null,
          unitIds: [unit.id],
          expiresAt: null,
        });
      }
      await memberships.create(tx, {
        personId: consultant.id,
        role: 'CONSULTANT',
        clientId: null,
        consultantClientIds: [client.id],
        unitIds: null,
        expiresAt: null,
      });
      const act = await acts.create(tx, {
        name: 'Income Tax Act, 1961',
        shortName: null,
        jurisdiction: 'CENTRAL',
        stateCode: null,
        aliases: [],
      });
      const category = await categories.create(tx, { name: 'Payments', aliases: [] });
      const obligation = await createObligation(tx, act.id, category.id);
      const assignment = await assignments.create(tx, {
        clientId: client.id,
        unitId: unit.id,
        obligationId: obligation,
        departmentId: department.id,
        defaultOwnerId: owner.id,
        defaultApproverId: approver.id,
        applicability: 'APPLICABLE',
        naReason: null,
        activeFrom: '2026-04-01' as never,
        activeTo: null,
      });
      unitId = unit.id;
      Object.assign(w, {
        clientId: client.id,
        assignmentId: assignment.id,
        ownerId: owner.id,
        approverId: approver.id,
        consultantId: consultant.id,
      });
    });
    await inFirm(firmA, async (tx) => {
      // T-7 owner reminder to an active owner with an address.
      w.reminded = (await instances.create(tx, instance('2026-10-19', 'OPEN'))).id;
      // +1 escalation to an approver with no address yet.
      w.escalated = (await instances.create(tx, instance('2026-10-11', 'SUBMITTED'))).id;
      // Complied: due today, but nothing is sent for it.
      await instances.create(tx, instance('2026-10-12', 'APPROVED'));
    });
    await inFirm(firmB, (tx) =>
      clients.create(tx, { name: 'Tata Group', settings: DEFAULT_CLIENT_SETTINGS }),
    );
    mailer = captureMailer();
    deps = { store: postgresJobStore(t.db), mailer, clock: () => now, appUrl: APP_URL };
  }, 120_000);

  afterAll(async () => {
    await t?.drop();
  });

  async function createObligation(
    tx: TenantTx,
    actId: string,
    categoryId: string,
  ): Promise<string> {
    const o = await obligations.create(tx, {
      externalRef: 'TAX-CL-033-6067-60218',
      domain: 'TAX',
      jurisdiction: 'CENTRAL',
      stateCode: null,
      actId,
      categoryId,
      title: 'Deposit TDS',
      description: 'Deposit tax deducted at source by the 7th.',
      applicabilityText: null,
      criticality: 'HIGH',
      timelineType: 'TIME_BASED',
      recurrenceRule: { kind: 'MONTHLY', day: 7, offsetMonths: 1 },
      ruleStatus: 'CONFIRMED',
      evidenceRequired: false,
      forms: [],
      logSheets: [],
      libraryVersion: 1,
    });
    return o.id;
  }

  describe('generate-instances', () => {
    let created = 0;

    it('creates the current and next FY with one audit row and one event per instance', async () => {
      const report = await runGenerateInstances(deps, 'job:generate-instances:1');
      created = report.created!;
      // Monthly, due the 7th of the following month: Apr 2026 to Mar 2028 is 24 periods.
      expect(created).toBe(24);
      expect(await t.count(firmA, 'compliance_instance', 'archived_at is null')).toBe(3 + 24);
      expect(
        await t.count(firmA, 'audit_event', "entity_type = 'instance' and request_id = $1", [
          'job:generate-instances:1',
        ]),
      ).toBe(24);
      expect(
        await t.count(
          firmA,
          'domain_event',
          "type = 'instance.generated' and aggregate_type = 'instance' and aggregate_version = 1",
        ),
      ).toBe(24);
    });

    it('creates nothing on a second run', async () => {
      const report = await runGenerateInstances(deps, 'job:generate-instances:2');
      expect(report.created).toBe(0);
      expect(await t.count(firmA, 'compliance_instance')).toBe(3 + created);
      expect(
        await t.count(firmA, 'audit_event', 'request_id = $1', ['job:generate-instances:2']),
      ).toBe(0);
    });

    it("never writes into another firm's tenant", async () => {
      expect(await t.count(firmB, 'compliance_instance')).toBe(0);
      expect(await t.count(firmB, 'audit_event')).toBe(0);
      expect(await t.count(firmB, 'domain_event')).toBe(0);
    });
  });

  describe('reminders', () => {
    it('sends the owner reminder, records the escalation with no address as failed, skips the complied item', async () => {
      const report = await runReminders(deps, 'job:reminders:1');
      expect(report).toMatchObject({ sent: 1, failedNO_EMAIL: 1 });
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]!.to.email).toBe('owner01@example.com');
      expect(mailer.sent[0]!.html).toContain(`instance=${w.reminded}`);
      expect(
        await t.count(
          firmA,
          'notification_send',
          "kind = 'OWNER_REMINDER' and instance_id = $1 and recipient_id = $2 and send_date = '2026-10-12' and sent_at is not null",
          [w.reminded, w.ownerId],
        ),
      ).toBe(1);
      expect(
        await t.count(
          firmA,
          'notification_send',
          "kind = 'APPROVER_ESCALATION' and instance_id = $1 and failure_code = 'NO_EMAIL' and sent_at is null",
          [w.escalated],
        ),
      ).toBe(1);
      expect(await t.count(firmA, 'notification_send')).toBe(2);
    });

    it("names the send-log row as the notification.sent event's aggregate", async () => {
      expect(
        await t.count(
          firmA,
          'domain_event e',
          `e.type = 'notification.sent' and e.aggregate_type = 'notification_send' and e.aggregate_version = 1
           and e.request_id = 'job:reminders:1'
           and exists (select 1 from notification_send n where n.id = e.aggregate_id and n.sent_at is not null)`,
        ),
      ).toBe(1);
    });

    it('sends nothing on a repeat run the same day', async () => {
      const report = await runReminders(deps, 'job:reminders:2');
      expect(report.sent).toBe(0);
      expect(mailer.sent).toHaveLength(1);
      expect(await t.count(firmA, 'notification_send')).toBe(2);
    });

    it('sends again when the mail transport failed before the send was recorded', async () => {
      now = '2026-10-16T01:30:00.000Z'; // T-3 for the 19th
      mailer.failNext(1);
      await expect(runReminders(deps, 'job:reminders:3')).rejects.toThrow('1 send(s) failed');
      expect(
        await t.count(
          firmA,
          'notification_send',
          "send_date = '2026-10-16' and sent_at is null and failure_code is null",
        ),
      ).toBe(1);
      const retry = await runReminders(deps, 'job:reminders:4');
      expect(retry.sent).toBe(1);
      expect(
        await t.count(
          firmA,
          'notification_send',
          "send_date = '2026-10-16' and sent_at is not null",
        ),
      ).toBe(1);
      now = '2026-10-12T01:30:00.000Z';
    });
  });

  describe('consultant digest', () => {
    it('sends one digest per consultant per India date, then nothing', async () => {
      const before = mailer.sent.length;
      const first = await runConsultantDigest(deps, 'job:consultant-digest:1');
      expect(first.sent).toBe(1);
      expect(mailer.sent.at(-1)!.to.email).toBe('consultant01@example.com');
      const again = await runConsultantDigest(deps, 'job:consultant-digest:2');
      expect(again.sent).toBe(0);
      expect(mailer.sent).toHaveLength(before + 1);
      expect(
        await t.count(
          firmA,
          'notification_send',
          "kind = 'CONSULTANT_DIGEST' and instance_id is null and recipient_id = $1 and sent_at is not null",
          [w.consultantId],
        ),
      ).toBe(1);
    });
  });
});
