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
// Two firms hold the same shape of data, so every assertion also checks that each firm's rows stay its own.
const url = process.env.DATABASE_URL;

/** One firm's client, people and instances. */
interface FirmWorld {
  firmId: string;
  clientName: string;
  clientId: string;
  ownerId: string;
  ownerEmail: string;
  approverId: string;
  consultantId: string;
  consultantEmail: string;
  /** OPEN, due 2026-10-19: T-7 owner reminder on the 12th. */
  reminded: string;
  /** SUBMITTED, due 2026-10-11: +1 escalation on the 12th, to an approver with no address. */
  escalated: string;
}

/** Rows of `table` (aliased `x`) whose `column` names no row of `target` in the same firm. */
function strays(column: string, target: string): string {
  return `x.${column} is not null and not exists (select 1 from ${target} y where y.id = x.${column} and y.firm_id = x.firm_id)`;
}

describe.skipIf(!url)('jobs on the Postgres store', () => {
  let t: JobTestDatabase;
  let a: FirmWorld;
  let b: FirmWorld;
  let mailer: CaptureMailer;
  let now = '2026-10-12T01:30:00.000Z';
  let deps: JobDeps;

  const inFirm = <T>(firmId: string, fn: (tx: TenantTx) => Promise<T>) =>
    t.db.withTenant(systemContext(firmId, 'jobs-db-test'), fn);

  async function seedFirm(firmName: string, clientName: string, n: string): Promise<FirmWorld> {
    const firmId = await t.admin.createFirm({ name: firmName });
    const world = await inFirm(firmId, async (tx) => {
      const client = await clients.create(tx, {
        name: clientName,
        settings: DEFAULT_CLIENT_SETTINGS,
      });
      const company = await companies.create(tx, { clientId: client.id, name: `Company ${n}` });
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
        name: `Plant ${n}`,
        locationId: location.id,
      });
      const department = await departments.create(tx, {
        clientId: client.id,
        name: 'Finance',
        aliases: [],
      });
      const owner = await people.create(tx, {
        displayName: `Owner ${n}`,
        nameNormalized: `owner ${n}`,
        email: `owner${n}@example.com`,
        status: 'ACTIVE',
      });
      const approver = await people.create(tx, {
        displayName: `Approver ${n}`,
        nameNormalized: `approver ${n}`,
        email: null,
        status: 'UNCLAIMED',
      });
      const consultant = await people.create(tx, {
        displayName: `Consultant ${n}`,
        nameNormalized: `consultant ${n}`,
        email: `consultant${n}@example.com`,
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
      const obligation = await obligations.create(tx, {
        externalRef: 'TAX-CL-033-6067-60218',
        domain: 'TAX',
        jurisdiction: 'CENTRAL',
        stateCode: null,
        actId: act.id,
        categoryId: category.id,
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
      const assignment = await assignments.create(tx, {
        clientId: client.id,
        unitId: unit.id,
        obligationId: obligation.id,
        departmentId: department.id,
        defaultOwnerId: owner.id,
        defaultApproverId: approver.id,
        applicability: 'APPLICABLE',
        naReason: null,
        activeFrom: '2026-04-01' as never,
        activeTo: null,
      });
      const instance = (dueDate: string, state: 'OPEN' | 'SUBMITTED' | 'APPROVED') =>
        instances.create(tx, {
          clientId: client.id,
          unitId: unit.id,
          assignmentId: assignment.id,
          // A one-day period on the due date never collides with the generated months, which start on the 1st.
          periodStart: dueDate,
          periodEnd: dueDate,
          dueDate,
          workflowState: state,
          pendingKind: state === 'SUBMITTED' ? 'COMPLETION' : null,
          completedOn: state === 'OPEN' ? null : '2026-10-01',
          naReason: null,
          ownerId: owner.id,
          approverId: approver.id,
          submittedAt: null,
          approvedAt: null,
          dueDateOverridden: false,
        } as unknown as Parameters<typeof instances.create>[1]);
      const reminded = await instance('2026-10-19', 'OPEN');
      const escalated = await instance('2026-10-11', 'SUBMITTED');
      // Complied: due today, but nothing is sent for it.
      await instance('2026-10-12', 'APPROVED');
      return {
        clientId: client.id,
        ownerId: owner.id,
        approverId: approver.id,
        consultantId: consultant.id,
        reminded: reminded.id,
        escalated: escalated.id,
      };
    });
    return {
      ...world,
      firmId,
      clientName,
      ownerEmail: `owner${n}@example.com`,
      consultantEmail: `consultant${n}@example.com`,
    };
  }

  /** Each firm's job rows name only that firm's instances, people and send-log rows. */
  async function expectNoStrays(): Promise<void> {
    for (const f of [a, b]) {
      expect(
        await t.count(
          f.firmId,
          'notification_send x',
          strays('instance_id', 'compliance_instance'),
        ),
      ).toBe(0);
      expect(await t.count(f.firmId, 'notification_send x', strays('recipient_id', 'person'))).toBe(
        0,
      );
      expect(await t.count(f.firmId, 'notification_send x', strays('client_id', 'client'))).toBe(0);
      expect(
        await t.count(
          f.firmId,
          'domain_event x',
          `x.aggregate_type = 'instance' and ${strays('aggregate_id', 'compliance_instance')}`,
        ),
      ).toBe(0);
      expect(
        await t.count(
          f.firmId,
          'domain_event x',
          `x.aggregate_type = 'notification_send' and ${strays('aggregate_id', 'notification_send')}`,
        ),
      ).toBe(0);
      expect(
        await t.count(
          f.firmId,
          'audit_event x',
          `x.entity_type = 'instance' and ${strays('entity_id', 'compliance_instance')}`,
        ),
      ).toBe(0);
    }
  }

  beforeAll(async () => {
    t = await createJobTestDatabase(url!);
    a = await seedFirm('Demo Advisory', 'Aditya Birla Group', '01');
    b = await seedFirm('Second Ledger Consulting', 'Tata Group', '02');
    mailer = captureMailer();
    deps = { store: postgresJobStore(t.db), mailer, clock: () => now, appUrl: APP_URL };
  }, 120_000);

  afterAll(async () => {
    await t?.drop();
  });

  describe('generate-instances', () => {
    it('creates the current and next FY in each firm with one audit row and one event per instance', async () => {
      const report = await runGenerateInstances(deps, 'job:generate-instances:1');
      // Monthly, due the 7th of the following month: Apr 2026 to Mar 2028 is 24 periods per firm.
      expect(report.created).toBe(48);
      for (const f of [a, b]) {
        expect(await t.count(f.firmId, 'compliance_instance', 'archived_at is null')).toBe(3 + 24);
        expect(
          await t.count(f.firmId, 'audit_event', "entity_type = 'instance' and request_id = $1", [
            'job:generate-instances:1',
          ]),
        ).toBe(24);
        expect(
          await t.count(
            f.firmId,
            'domain_event',
            "type = 'instance.generated' and aggregate_type = 'instance' and aggregate_version = 1",
          ),
        ).toBe(24);
      }
      await expectNoStrays();
    });

    it('creates nothing on a second run', async () => {
      const report = await runGenerateInstances(deps, 'job:generate-instances:2');
      expect(report.created).toBe(0);
      for (const f of [a, b]) {
        expect(await t.count(f.firmId, 'compliance_instance')).toBe(3 + 24);
        expect(
          await t.count(f.firmId, 'audit_event', 'request_id = $1', ['job:generate-instances:2']),
        ).toBe(0);
      }
    });
  });

  describe('reminders', () => {
    it("sends each firm's owner reminder, records each escalation with no address as failed, skips complied items", async () => {
      const report = await runReminders(deps, 'job:reminders:1');
      expect(report).toMatchObject({ firms: 2, sent: 2, failedNO_EMAIL: 2 });
      expect(mailer.sent.map((m) => m.to.email).sort()).toEqual([a.ownerEmail, b.ownerEmail]);
      for (const f of [a, b]) {
        const mail = mailer.sent.find((m) => m.to.email === f.ownerEmail)!;
        expect(mail.html).toContain(`/c/${f.clientId}/register?instance=${f.reminded}`);
        expect(
          await t.count(
            f.firmId,
            'notification_send',
            "kind = 'OWNER_REMINDER' and instance_id = $1 and recipient_id = $2 and send_date = '2026-10-12' and sent_at is not null",
            [f.reminded, f.ownerId],
          ),
        ).toBe(1);
        expect(
          await t.count(
            f.firmId,
            'notification_send',
            "kind = 'APPROVER_ESCALATION' and instance_id = $1 and recipient_id = $2 and failure_code = 'NO_EMAIL' and sent_at is null",
            [f.escalated, f.approverId],
          ),
        ).toBe(1);
        expect(await t.count(f.firmId, 'notification_send')).toBe(2);
      }
      await expectNoStrays();
    });

    it("names the send-log row as the notification.sent event's aggregate", async () => {
      for (const f of [a, b]) {
        expect(
          await t.count(
            f.firmId,
            'domain_event e',
            `e.type = 'notification.sent' and e.aggregate_type = 'notification_send' and e.aggregate_version = 1
             and e.request_id = 'job:reminders:1'
             and exists (select 1 from notification_send n
                         where n.id = e.aggregate_id and n.firm_id = e.firm_id and n.sent_at is not null)`,
          ),
        ).toBe(1);
      }
    });

    it('sends nothing on a repeat run the same day', async () => {
      const report = await runReminders(deps, 'job:reminders:2');
      expect(report.sent).toBe(0);
      expect(mailer.sent).toHaveLength(2);
      for (const f of [a, b]) expect(await t.count(f.firmId, 'notification_send')).toBe(2);
    });

    it('sends again when the mail transport failed before the send was recorded', async () => {
      now = '2026-10-16T01:30:00.000Z'; // T-3 for the 19th, in both firms
      mailer.failNext(1);
      await expect(runReminders(deps, 'job:reminders:3')).rejects.toThrow('1 send(s) failed');
      const pending = "send_date = '2026-10-16' and sent_at is null and failure_code is null";
      const sent = "send_date = '2026-10-16' and sent_at is not null";
      expect(
        (await t.count(a.firmId, 'notification_send', pending)) +
          (await t.count(b.firmId, 'notification_send', pending)),
      ).toBe(1);
      const retry = await runReminders(deps, 'job:reminders:4');
      expect(retry.sent).toBe(1);
      for (const f of [a, b]) expect(await t.count(f.firmId, 'notification_send', sent)).toBe(1);
      await expectNoStrays();
      now = '2026-10-12T01:30:00.000Z';
    });
  });

  describe('consultant digest', () => {
    it("sends each firm's consultant one digest about their own client, then nothing", async () => {
      const before = mailer.sent.length;
      const first = await runConsultantDigest(deps, 'job:consultant-digest:1');
      expect(first.sent).toBe(2);
      const digests = mailer.sent.slice(before);
      expect(digests.map((m) => m.to.email).sort()).toEqual([a.consultantEmail, b.consultantEmail]);
      for (const [f, other] of [
        [a, b],
        [b, a],
      ] as const) {
        const mail = digests.find((m) => m.to.email === f.consultantEmail)!;
        expect(mail.text).toContain(f.clientName);
        expect(mail.text).not.toContain(other.clientName);
        expect(
          await t.count(
            f.firmId,
            'notification_send',
            "kind = 'CONSULTANT_DIGEST' and instance_id is null and recipient_id = $1 and client_id = $2 and sent_at is not null",
            [f.consultantId, f.clientId],
          ),
        ).toBe(1);
      }
      const again = await runConsultantDigest(deps, 'job:consultant-digest:2');
      expect(again.sent).toBe(0);
      expect(mailer.sent).toHaveLength(before + 2);
      await expectNoStrays();
    });
  });
});
