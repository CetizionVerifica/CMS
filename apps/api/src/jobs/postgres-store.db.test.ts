import { randomUUID } from 'node:crypto';
import { DEFAULT_CLIENT_SETTINGS } from '@canopy/contracts';
import {
  acts,
  assignments,
  categories,
  clients,
  companies,
  departments,
  instances,
  invites,
  locations,
  memberships,
  obligations,
  domainEvents,
  evidence,
  people,
  systemContext,
  units,
  type TenantTx,
} from '@canopy/db';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNT_DAILY, runAccountDaily } from './accounts.js';
import { CONSUMERS } from './consumers.js';
import { runConsultantDigest } from './digest.js';
import { runGenerateInstances } from './generate-instances.js';
import type { JobDeps } from './ports.js';
import { runRelayOutbox } from './outbox-relay.js';
import type { EventBus, OutboxEvent } from './ports.js';
import { postgresJobStore } from './postgres-store.js';
import { runReminders } from './reminders.js';
import { runScanEvidence } from './scan-evidence.js';
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
  /** What a second assignment needs, for the event consumer test. */
  unitId: string;
  obligationId: string;
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
        city: 'Riverbend',
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
        unitId: unit.id,
        obligationId: obligation.id,
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
    a = await seedFirm('Demo Advisory', 'Kestrel Metals Group', '01');
    b = await seedFirm('Second Ledger Consulting', 'Osprey Textiles Group', '02');
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
  describe('outbox relay and event consumers', () => {
    it("publishes each firm's consumed events with its own firm id, marks every event published, then nothing", async () => {
      const published: OutboxEvent[] = [];
      const consumed = new Set(CONSUMERS.map((c) => c.type));
      const bus: EventBus = {
        consumes: (type) => consumed.has(type),
        publish: async (event) => void published.push(event),
      };
      // What M6 writes when an assignment is created: the row and its event in one transaction.
      const added = await inFirm(a.firmId, async (tx) => {
        const payroll = await departments.create(tx, {
          clientId: a.clientId,
          name: 'Payroll',
          aliases: [],
        });
        const row = await assignments.create(tx, {
          clientId: a.clientId,
          unitId: a.unitId,
          obligationId: a.obligationId,
          departmentId: payroll.id,
          defaultOwnerId: a.ownerId,
          defaultApproverId: a.approverId,
          applicability: 'APPLICABLE',
          naReason: null,
          activeFrom: '2026-04-01' as never,
          activeTo: null,
        });
        await domainEvents.enqueue(tx, {
          type: 'assignment.created',
          clientId: a.clientId,
          actor: { kind: 'PERSON', personId: a.ownerId },
          requestId: 'req:m6',
          aggregate: { type: 'assignment', id: row.id },
          aggregateVersion: row.version,
          data: { assignmentId: row.id },
        });
        return row;
      });

      const report = await runRelayOutbox({ ...deps, bus }, 'job:relay-outbox:1');
      expect(report).toMatchObject({ firms: 2, published: 1, failed: 0 });
      expect(published).toEqual([
        expect.objectContaining({
          type: 'assignment.created',
          firmId: a.firmId,
          clientId: a.clientId,
          data: { assignmentId: added.id },
        }),
      ]);
      for (const f of [a, b]) {
        expect(await t.count(f.firmId, 'domain_event', 'published_at is null')).toBe(0);
      }
      const again = await runRelayOutbox({ ...deps, bus }, 'job:relay-outbox:2');
      expect(again).toMatchObject({ published: 0, skipped: 0 });

      // The consumer, as pg-boss would run it: the new assignment gets its two FYs in firm A only.
      const event = published[0]!;
      const consumer = CONSUMERS.find((c) => c.type === event.type)!;
      const created = await consumer.handle(deps, event, `job:${event.type}:${event.id}`);
      expect(created).toMatchObject({ clients: 1, created: 24 });
      expect(await t.count(a.firmId, 'compliance_instance', 'assignment_id = $1', [added.id])).toBe(
        24,
      );
      expect(
        await t.count(a.firmId, 'audit_event', 'request_id = $1', [
          `job:${event.type}:${event.id}`,
        ]),
      ).toBe(24);
      expect(await t.count(b.firmId, 'compliance_instance')).toBe(3 + 24);
      await expectNoStrays();
    });

    it("emails firm B's owner once per current send-back and its approver per submission, keyed on the event", async () => {
      const published: OutboxEvent[] = [];
      const consumed = new Set(CONSUMERS.map((c) => c.type));
      const bus: EventBus = {
        consumes: (type) => consumed.has(type),
        publish: async (event) => void published.push(event),
      };
      const envelope = (type: string, instanceId: string, personId: string, version: number) => ({
        type,
        clientId: b.clientId,
        actor: { kind: 'PERSON' as const, personId },
        requestId: 'req:m7',
        aggregate: { type: 'instance', id: instanceId },
        aggregateVersion: version,
        data: { instanceId, ownerId: b.ownerId, approverId: b.approverId },
      });
      const consume = async (events: OutboxEvent[]) => {
        for (const event of events) {
          const consumer = CONSUMERS.find((c) => c.type === event.type)!;
          await consumer.handle(deps, event, `job:${event.type}:${event.id}`);
        }
      };
      // What M7 writes: a send-back of one instance and a submission of another, each with the version it left.
      const sentBack = await inFirm(b.firmId, async (tx) => {
        const submitted = await instances.require(tx, b.escalated);
        const row = await instances.create(tx, {
          clientId: b.clientId,
          unitId: b.unitId,
          assignmentId: submitted.assignmentId,
          periodStart: '2026-10-13',
          periodEnd: '2026-10-13',
          dueDate: '2026-10-13',
          workflowState: 'SENT_BACK',
          pendingKind: null,
          completedOn: null,
          naReason: null,
          ownerId: b.ownerId,
          approverId: b.approverId,
          submittedAt: null,
          approvedAt: null,
          dueDateOverridden: false,
        } as unknown as Parameters<typeof instances.create>[1]);
        await domainEvents.enqueue(
          tx,
          envelope('instance.sent_back', row.id, b.approverId, row.version),
        );
        await domainEvents.enqueue(
          tx,
          envelope('instance.submitted', b.escalated, b.ownerId, submitted.version),
        );
        return row;
      });
      expect(await runRelayOutbox({ ...deps, bus }, 'job:relay-outbox:3')).toMatchObject({
        published: 2,
        failed: 0,
      });
      // Both events share the transaction's time, so the relay's order between them is not fixed: find them by type.
      const firstSentBack = published.find((e) => e.type === 'instance.sent_back')!;
      const submission = published.find((e) => e.type === 'instance.submitted')!;
      const before = mailer.sent.length;
      await consume([firstSentBack, submission]);

      // The owner resubmits and the approver sends it back again the same day: a new version and event.
      await inFirm(b.firmId, async (tx) => {
        const again = await instances.update(tx, sentBack.id, sentBack.version, {
          workflowState: 'SENT_BACK',
        } as never);
        await domainEvents.enqueue(
          tx,
          envelope('instance.sent_back', sentBack.id, b.approverId, again.version),
        );
      });
      expect(await runRelayOutbox({ ...deps, bus }, 'job:relay-outbox:4')).toMatchObject({
        published: 1,
      });
      expect(published.every((e) => e.firmId === b.firmId)).toBe(true);
      // The second send-back, then both earlier events again: redelivered, and the first now stale.
      await consume([published[2]!, firstSentBack, submission]);

      // Two send-backs, two emails to the owner; the repeats send nothing.
      const sent = mailer.sent.slice(before);
      expect(sent.map((m) => m.to.email)).toEqual([b.ownerEmail, b.ownerEmail]);
      expect(sent[0]!.text).toContain(`/register?instance=${sentBack.id}`);
      expect(
        await t.count(b.firmId, 'notification_send', "kind = 'SENT_BACK' and sent_at is not null"),
      ).toBe(2);
      // The approver has no address yet: the submission is logged as failed, keyed on its event.
      expect(
        await t.count(
          b.firmId,
          'notification_send',
          "kind = 'APPROVAL_REQUESTED' and failure_code = 'NO_EMAIL' and event_id = $1",
          [submission.id],
        ),
      ).toBe(1);
      expect(await t.count(b.firmId, 'notification_send', 'event_id is not null')).toBe(3);
      expect(await t.count(a.firmId, 'notification_send', 'event_id is not null')).toBe(0);
      await expectNoStrays();
    });
  });

  describe('sign-in link and invite emails', () => {
    const TOKEN = 'raw-db-token-Zt3';
    const issued: { kind: string; personId: string; inviteId?: string }[] = [];
    let firmBInvite: { id: string; personId: string } | undefined;
    const withIssuer = (): JobDeps => ({
      ...deps,
      issueLoginToken: async (input) => {
        issued.push(input);
        return { token: TOKEN, expiresAt: new Date(Date.parse(now) + 15 * 60_000).toISOString() };
      },
    });
    const outboxEvent = (
      f: FirmWorld,
      type: string,
      clientId: string | null,
      actorId: string,
      data: Record<string, unknown>,
    ): OutboxEvent => ({
      id: randomUUID(),
      type,
      schemaVersion: 1,
      occurredAt: now,
      firmId: f.firmId,
      clientId,
      actor: { kind: 'PERSON', personId: actorId },
      requestId: `req:${type}`,
      aggregate: { type: 'person', id: String(data.personId) },
      aggregateVersion: 1,
      data,
    });
    const handle = (e: OutboxEvent) =>
      CONSUMERS.find((c) => c.type === e.type)!.handle(withIssuer(), e, `job:${e.type}:${e.id}`);

    it('emails a client invite, a firm-role invite and a sign-in link, keyed on the event, with no token stored', async () => {
      now = '2026-10-13T09:30:00.000Z';
      const before = mailer.sent.length;
      const { clientInvite, firmInvite, invitee, staff } = await inFirm(b.firmId, async (tx) => {
        const invitee = await people.create(tx, {
          displayName: 'Ravi Kumar',
          nameNormalized: 'ravi kumar',
          email: null,
          status: 'UNCLAIMED',
        });
        const staff = await people.create(tx, {
          displayName: 'Nina Das',
          nameNormalized: 'nina das',
          email: null,
          status: 'UNCLAIMED',
        });
        const grant = (role: 'OWNER' | 'CONSULTANT') => ({
          role,
          clientId: role === 'OWNER' ? b.clientId : null,
          consultantClientIds: role === 'OWNER' ? null : [b.clientId],
          unitIds: role === 'OWNER' ? [b.unitId] : null,
          expiresAt: null,
        });
        const clientInvite = await invites.create(
          tx,
          {
            personId: invitee.id,
            email: 'ravi@example.com',
            grant: grant('OWNER'),
            createdById: b.consultantId,
            expiresAt: '2026-10-20T09:30:00.000Z',
          },
          now,
        );
        const firmInvite = await invites.create(
          tx,
          {
            personId: staff.id,
            email: 'nina@example.com',
            grant: grant('CONSULTANT'),
            createdById: b.consultantId,
            expiresAt: '2026-10-20T09:30:00.000Z',
          },
          now,
        );
        return { clientInvite: clientInvite.invite, firmInvite: firmInvite.invite, invitee, staff };
      });
      firmBInvite = clientInvite;
      const events = [
        outboxEvent(b, 'person.invited', b.clientId, b.consultantId, {
          personId: invitee.id,
          inviteId: clientInvite.id,
          role: 'OWNER',
          clientId: b.clientId,
        }),
        outboxEvent(b, 'person.invited', null, b.consultantId, {
          personId: staff.id,
          inviteId: firmInvite.id,
          role: 'CONSULTANT',
          clientId: null,
        }),
        outboxEvent(b, 'auth.magic_link_requested', null, b.ownerId, { personId: b.ownerId }),
      ];
      for (const e of [...events, ...events]) await handle(e);

      const sent = mailer.sent.slice(before);
      expect(sent.map((m) => m.to.email)).toEqual([
        'ravi@example.com',
        'nina@example.com',
        b.ownerEmail,
      ]);
      expect(sent[0]!.text).toContain('Consultant 02 invited you');
      expect(sent[0]!.text).toContain('Osprey Textiles Group, with Second Ledger Consulting');
      expect(sent[0]!.text).toContain(`${APP_URL}/invite/${TOKEN}`);
      expect(sent[2]!.text).toContain(`${APP_URL}/login/link?token=${TOKEN}`);
      expect(issued.map((i) => i.kind)).toEqual(['INVITE', 'INVITE', 'MAGIC_LINK']);

      for (const e of events) {
        expect(
          await t.count(b.firmId, 'notification_send', 'event_id = $1 and sent_at is not null', [
            e.id,
          ]),
        ).toBe(1);
      }
      expect(
        await t.count(
          b.firmId,
          'notification_send',
          "kind in ('INVITE', 'MAGIC_LINK') and client_id is null",
        ),
      ).toBe(2);
      expect(await t.count(b.firmId, 'domain_event', 'data::text like $1', [`%${TOKEN}%`])).toBe(0);
      expect(await t.count(a.firmId, 'notification_send', "kind in ('INVITE', 'MAGIC_LINK')")).toBe(
        0,
      );
      await expectNoStrays();
    });

    it('finds nothing of another firm: an invite or person id from firm B is stale in firm A', async () => {
      const invite = firmBInvite;
      const crossed = outboxEvent(a, 'person.invited', null, a.consultantId, {
        personId: invite!.personId,
        inviteId: invite!.id,
        role: 'OWNER',
        clientId: null,
      });
      expect(await handle(crossed)).toEqual({ sent: 0, skippedStale: 1 });
      const link = outboxEvent(a, 'auth.magic_link_requested', null, b.ownerId, {
        personId: b.ownerId,
      });
      expect(await handle(link)).toEqual({ sent: 0, skippedStale: 1 });
    });
  });

  describe('evidence scan', () => {
    async function upload(f: FirmWorld, text: string, files: Map<string, string>) {
      const key = `${f.firmId}/${f.clientId}/${f.reminded}/${randomUUID()}`;
      files.set(key, text);
      return inFirm(f.firmId, (tx) =>
        evidence.create(tx, {
          instanceId: f.reminded,
          clientId: f.clientId,
          storageKey: key,
          fileName: 'challan-october.pdf',
          mimeType: 'application/pdf',
          sizeBytes: text.length,
          sha256: 'a'.repeat(64),
          uploadedById: f.ownerId,
        }),
      );
    }

    it("records each firm's scan results with an audit row and an event, leaves archived files, then does nothing", async () => {
      const files = new Map<string, string>();
      const cleanA = await upload(a, '%PDF-1.7 challan', files);
      const infectedA = await upload(a, 'X5O!P EICAR', files);
      const archivedA = await upload(a, '%PDF-1.7 old', files);
      await inFirm(a.firmId, (tx) => evidence.archive(tx, archivedA.id));
      const cleanB = await upload(b, '%PDF-1.7 return', files);
      const scanned: string[] = [];
      const scanDeps: JobDeps = {
        ...deps,
        scanner: {
          async scan(content) {
            let text = '';
            for await (const chunk of content) text += Buffer.from(chunk).toString();
            scanned.push(text);
            return text.includes('EICAR')
              ? { status: 'INFECTED', signature: 'Eicar-Test-Signature' }
              : { status: 'CLEAN' };
          },
        },
        evidenceObjects: {
          async open(key) {
            const text = files.get(key);
            return text === undefined
              ? null
              : (async function* () {
                  yield Buffer.from(text);
                })();
          },
        },
      };

      expect(await runScanEvidence(scanDeps, 'job:scan-evidence:db')).toEqual({
        firms: 2,
        clean: 2,
        infected: 1,
        failed: 0,
        retry: 0,
      });
      expect(scanned.sort()).toEqual(['%PDF-1.7 challan', '%PDF-1.7 return', 'X5O!P EICAR']);

      const status = (f: FirmWorld, id: string) =>
        inFirm(f.firmId, async (tx) => (await evidence.require(tx, id)).scanStatus);
      expect(await status(a, cleanA.id)).toBe('CLEAN');
      expect(await status(a, infectedA.id)).toBe('INFECTED');
      expect(await status(a, archivedA.id)).toBe('PENDING');
      expect(await status(b, cleanB.id)).toBe('CLEAN');

      for (const [f, ids] of [
        [a, [cleanA.id, infectedA.id]],
        [b, [cleanB.id]],
      ] as const) {
        expect(
          await t.count(
            f.firmId,
            'audit_event',
            `entity_type = 'instance' and entity_id = $2 and action = 'UPDATE' and request_id = 'job:scan-evidence:db' and (after->>'evidenceId') = any($1)`,
            [ids, f.reminded],
          ),
        ).toBe(ids.length);
        expect(
          await t.count(
            f.firmId,
            'domain_event',
            `type = 'evidence.scanned' and aggregate_type = 'instance' and aggregate_id = $1 and (data->>'evidenceId') = any($2)`,
            [f.reminded, ids],
          ),
        ).toBe(ids.length);
        // Ids and the status only: no file name or storage key in the event.
        expect(
          await t.count(
            f.firmId,
            'domain_event',
            `type = 'evidence.scanned' and (data::text like '%challan%' or data::text like '%' || $1 || '%')`,
            [f.firmId],
          ),
        ).toBe(0);
      }
      expect(
        await t.count(
          a.firmId,
          'audit_event',
          `entity_type = 'instance' and (after->>'evidenceId') = $1 and after->>'scanStatus' = 'INFECTED' and after->>'signature' = 'Eicar-Test-Signature'`,
          [infectedA.id],
        ),
      ).toBe(1);
      await expectNoStrays();

      expect(await runScanEvidence(scanDeps, 'job:scan-evidence:db2')).toMatchObject({
        clean: 0,
        infected: 0,
      });
      expect(scanned).toHaveLength(3);
    });

    it('counts failed attempts on the audit trail and marks the file FAILED on the third', async () => {
      const files = new Map<string, string>();
      const cut = await upload(a, '%PDF-1.7 cut short', files);
      const scanDeps: JobDeps = {
        ...deps,
        scanner: {
          async scan(content) {
            for await (const chunk of content) void chunk;
            return { status: 'CLEAN' };
          },
        },
        // Storage sends only part of the file each time.
        evidenceObjects: {
          async open() {
            return (async function* () {
              yield Buffer.from('%PDF');
            })();
          },
        },
      };
      const attempts = () =>
        t.count(
          a.firmId,
          'audit_event',
          `entity_type = 'instance' and (after->>'evidenceId') = $1 and action = 'UPDATE' and after->>'scanStatus' = 'PENDING' and after->>'scanError' = 'TRUNCATED'`,
          [cut.id],
        );

      expect(await runScanEvidence(scanDeps, 'job:scan-evidence:try1')).toMatchObject({
        clean: 0,
        retry: 1,
      });
      expect(await attempts()).toBe(1);
      await runScanEvidence(scanDeps, 'job:scan-evidence:try2');
      expect(await attempts()).toBe(2);
      expect(await runScanEvidence(scanDeps, 'job:scan-evidence:try3')).toMatchObject({
        clean: 0,
        failed: 1,
        retry: 0,
      });
      expect(
        await inFirm(a.firmId, async (tx) => (await evidence.require(tx, cut.id)).scanStatus),
      ).toBe('FAILED');
      expect(
        await t.count(
          a.firmId,
          'audit_event',
          `entity_type = 'instance' and (after->>'evidenceId') = $1 and after->>'scanStatus' = 'FAILED' and (after->>'attempts')::int = 3`,
          [cut.id],
        ),
      ).toBe(1);
      await expectNoStrays();
    });
  });

  describe(ACCOUNT_DAILY, () => {
    /** Runs `sql` as the table owner inside the firm, as a migration would (FORCE RLS binds the owner). */
    async function asOwner<T>(firmId: string, sql: string, values: unknown[] = []): Promise<T[]> {
      const client = new pg.Client({ connectionString: t.url });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmId]);
        const { rows } = await client.query(sql, values);
        await client.query('COMMIT');
        return rows as T[];
      } finally {
        await client.end();
      }
    }

    it('ends a lapsed trial with its audit row and event, records usage, and generation then skips it', async () => {
      const trial = await seedFirm('Osprey Advisory', 'Osprey Textiles Group', 'trial');
      await asOwner(
        trial.firmId,
        `UPDATE firm SET status = 'TRIAL', trial_ends_on = '2026-10-11' WHERE id = $1`,
        [trial.firmId],
      );
      now = '2026-10-11T19:00:00.000Z'; // 12 Oct 00:30 IST
      const report = await runAccountDaily(deps, 'job:account-daily:1');
      expect(report).toMatchObject({ trialsEnded: 1 });
      expect(report.snapshots).toBe(report.firms);
      const [firm] = await asOwner<{ status: string }>(
        trial.firmId,
        'SELECT status FROM firm WHERE id = $1',
        [trial.firmId],
      );
      expect(firm).toEqual({ status: 'SUSPENDED' });
      expect(
        await t.count(
          trial.firmId,
          'audit_event',
          `entity_type = 'account' and action = 'TRANSITION' and actor_kind = 'SYSTEM'`,
        ),
      ).toBe(1);
      expect(
        await t.count(
          trial.firmId,
          'domain_event',
          `type = 'account.status_changed' and actor->>'job' = $1`,
          [ACCOUNT_DAILY],
        ),
      ).toBe(1);
      const snapshots = await asOwner<{ taken_on: string; units: number }>(
        trial.firmId,
        `SELECT taken_on::text, units FROM platform.usage_snapshot WHERE account_id = $1`,
        [trial.firmId],
      );
      expect(snapshots).toEqual([{ taken_on: '2026-10-12', units: 1 }]);

      // Again the same night: nothing more to end, the snapshot is replaced, not added.
      expect(await runAccountDaily(deps, 'job:account-daily:2')).toMatchObject({ trialsEnded: 0 });
      expect(
        await asOwner(trial.firmId, 'SELECT 1 FROM platform.usage_snapshot WHERE account_id = $1', [
          trial.firmId,
        ]),
      ).toHaveLength(1);

      const seeded = await t.count(trial.firmId, 'compliance_instance');
      now = '2026-10-11T20:00:00.000Z';
      await runGenerateInstances(deps, 'job:generate:suspended');
      expect(await t.count(trial.firmId, 'compliance_instance')).toBe(seeded);
      expect(
        await t.count(trial.firmId, 'audit_event', `request_id = 'job:generate:suspended'`),
      ).toBe(0);
    });
  });
});
