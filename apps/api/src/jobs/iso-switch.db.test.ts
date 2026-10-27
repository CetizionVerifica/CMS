import { randomUUID } from 'node:crypto';
import { DEFAULT_CLIENT_SETTINGS, type LocalDate } from '@canopy/contracts';
import {
  accountJobs,
  acts,
  assignments,
  auditEvents,
  categories,
  clauseAssessments,
  clients,
  companies,
  controlledDocuments,
  departments,
  instances,
  isoActions,
  isoCatalogue,
  isoFiles,
  locations,
  managementSystems,
  memberships,
  obligations,
  people,
  riskItems,
  systemContext,
  units,
  type TenantTx,
} from '@canopy/db';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runGenerateInstances } from './generate-instances.js';
import { runIsoReminders } from './iso-reminders.js';
import type { JobDeps } from './ports.js';
import { postgresJobStore } from './postgres-store.js';
import { runReminders } from './reminders.js';
import { runScanEvidence } from './scan-evidence.js';
import { APP_URL } from './testing/builders.js';
import { captureMailer } from './testing/memory-store.js';
import { createJobTestDatabase, type JobTestDatabase } from './testing/postgres.js';

// ISO-10b and ISO-10c on M3's repositories and RLS, against Postgres 16 (CI `db` job); skipped without DATABASE_URL. One account
// holds a statutory and an ISO-standard assignment, each with an OPEN instance due today, and ISO files on a clause
// assessment; a second account holds only statutory work. 2026-10-12 01:30Z is 07:00 in Asia/Kolkata.
const url = process.env.DATABASE_URL;
const NOW = '2026-10-12T01:30:00.000Z';
const FY = { from: '2026-04-01' as LocalDate, to: '2027-03-31' as LocalDate };

interface World {
  firmId: string;
  clientId: string;
  ownerId: string;
  law: { assignmentId: string; instanceId: string };
  iso?: { obligationId: string; assignmentId: string; instanceId: string };
}

describe.skipIf(!url)('jobs and the ISO add-on on the Postgres store', () => {
  let t: JobTestDatabase;
  let withIso: World;
  let lawOnly: World;
  let deps: JobDeps;
  let iso: { systemId: string; subject: { type: 'clause_assessment'; id: string } };

  const inFirm = <T>(firmId: string, fn: (tx: TenantTx) => Promise<T>) =>
    t.db.withTenant(systemContext(firmId, 'iso-switch-db-test'), fn);

  async function seed(firmName: string, clientName: string, iso: boolean): Promise<World> {
    const firmId = await t.admin.createFirm({ name: firmName });
    return inFirm(firmId, async (tx) => {
      const client = await clients.create(tx, {
        name: clientName,
        settings: DEFAULT_CLIENT_SETTINGS,
      });
      const company = await companies.create(tx, {
        clientId: client.id,
        name: `${clientName} Ltd`,
      });
      const location = await locations.create(tx, {
        country: 'India',
        countryCode: 'IN',
        state: 'West Bengal',
        stateCode: 'WB',
        city: 'Highmoor',
      });
      const unit = await units.create(tx, {
        clientId: client.id,
        companyId: company.id,
        name: 'Highmoor Plant',
        locationId: location.id,
      });
      const department = await departments.create(tx, {
        clientId: client.id,
        name: 'Quality',
        aliases: [],
      });
      const owner = await people.create(tx, {
        displayName: 'Owner Stonebridge',
        nameNormalized: 'owner stonebridge',
        email: `owner-${randomUUID()}@example.com`,
        status: 'ACTIVE',
      });
      await memberships.create(tx, {
        personId: owner.id,
        role: 'OWNER',
        clientId: client.id,
        consultantClientIds: null,
        unitIds: [unit.id],
        expiresAt: null,
      });
      const category = await categories.create(tx, { name: 'Reviews', aliases: [] });
      const assign = async (kind: 'STATUTE' | 'STANDARD') => {
        const act = await acts.create(tx, {
          name: kind === 'STANDARD' ? 'ISO 9001' : 'Factories Act, 1948',
          shortName: null,
          jurisdiction: 'CENTRAL',
          stateCode: null,
          aliases: [],
          kind,
        });
        const obligation = await obligations.create(tx, {
          externalRef: `${kind}-REF-1`,
          domain: kind === 'STANDARD' ? 'OTHER' : 'EHS',
          jurisdiction: 'CENTRAL',
          stateCode: null,
          actId: act.id,
          categoryId: category.id,
          title: kind === 'STANDARD' ? 'Hold the management review' : 'File the annual return',
          description: 'Our own summary.',
          applicabilityText: null,
          criticality: 'HIGH',
          timelineType: 'TIME_BASED',
          recurrenceRule: { kind: 'MONTHLY', day: 12, offsetMonths: 0 },
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
          defaultApproverId: owner.id,
          applicability: 'APPLICABLE',
          naReason: null,
          activeFrom: '2026-04-01' as never,
          activeTo: null,
        });
        // Due today and OPEN: a T-0 owner reminder. A one-day period never collides with generated months.
        const due = await instances.create(tx, {
          clientId: client.id,
          unitId: unit.id,
          assignmentId: assignment.id,
          periodStart: '2026-10-12',
          periodEnd: '2026-10-12',
          dueDate: '2026-10-12',
          workflowState: 'OPEN',
          pendingKind: null,
          completedOn: null,
          naReason: null,
          ownerId: owner.id,
          approverId: owner.id,
          submittedAt: null,
          approvedAt: null,
          dueDateOverridden: false,
        } as unknown as Parameters<typeof instances.create>[1]);
        return { obligationId: obligation.id, assignmentId: assignment.id, instanceId: due.id };
      };
      const law = await assign('STATUTE');
      return {
        firmId,
        clientId: client.id,
        ownerId: owner.id,
        law: { assignmentId: law.assignmentId, instanceId: law.instanceId },
        ...(iso && { iso: await assign('STANDARD') }),
      };
    });
  }

  beforeAll(async () => {
    t = await createJobTestDatabase(url!);
    withIso = await seed('Northwind Assurance', 'Stonebridge Works', true);
    lawOnly = await seed('Heron Compliance Partners', 'Osprey Textiles Group', false);
    deps = {
      store: postgresJobStore(t.db),
      mailer: captureMailer(),
      clock: () => NOW,
      appUrl: APP_URL,
    };
  }, 120_000);

  afterAll(async () => {
    await t?.drop();
  });

  it('reads STANDARD obligations and instances, and STATUTE-only scores, in the account only', async () => {
    const iso = withIso.iso!;
    await deps.store.withFirm(withIso.firmId, 'req:iso', async (tx) => {
      expect(await tx.standardObligationIds()).toEqual([iso.obligationId]);
      expect(await tx.standardInstanceIds([iso.instanceId, withIso.law.instanceId])).toEqual([
        iso.instanceId,
      ]);
      const all = await tx.listScoreItems(withIso.clientId, FY);
      const statute = await tx.listScoreItems(withIso.clientId, FY, { actKinds: ['STATUTE'] });
      expect(all.map((i) => i.instanceId).sort()).toEqual(
        [iso.instanceId, withIso.law.instanceId].sort(),
      );
      expect(statute.map((i) => i.instanceId)).toEqual([withIso.law.instanceId]);
    });
    await deps.store.withFirm(lawOnly.firmId, 'req:iso', async (tx) => {
      expect(await tx.standardObligationIds()).toEqual([]);
      // Another account's STANDARD instance is invisible here.
      expect(await tx.standardInstanceIds([iso.instanceId, lawOnly.law.instanceId])).toEqual([]);
    });
  });

  it('lists only the accounts with the feature', async () => {
    expect(await deps.store.listFirmIdsWithFeature!('isoManagement')).toEqual([]);
    const client = new pg.Client({ connectionString: t.url });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO platform.account_override (account_id, features) VALUES ($1, '{isoManagement}')`,
        [withIso.firmId],
      );
    } finally {
      await client.end();
    }
    expect(await deps.store.listFirmIdsWithFeature!('isoManagement')).toEqual([withIso.firmId]);
    // The feature alone is not enough: the catalogue copy is not recorded, so the jobs still treat it as off.
    expect(
      (await deps.store.withFirm(withIso.firmId, 'req:iso', (tx) => tx.accountFeatures()))
        .isoCatalogueCopiedAt,
    ).toBeNull();
  });

  it('generates and reminds statutory work only while the add-on is not served', async () => {
    await runGenerateInstances(deps, 'job:iso:generate');
    await runReminders(deps, 'job:iso:reminders');
    const iso = withIso.iso!;
    expect(
      await t.count(withIso.firmId, 'compliance_instance', 'assignment_id = $1', [
        iso.assignmentId,
      ]),
    ).toBe(1);
    expect(
      await t.count(withIso.firmId, 'compliance_instance', 'assignment_id = $1', [
        withIso.law.assignmentId,
      ]),
    ).toBeGreaterThan(1);
    expect(
      await t.count(withIso.firmId, 'notification_send', 'instance_id = $1', [iso.instanceId]),
    ).toBe(0);
    expect(
      await t.count(withIso.firmId, 'notification_send', 'instance_id = $1', [
        withIso.law.instanceId,
      ]),
    ).toBe(1);
  });

  it('scans PENDING ISO files with the add-on off, audits the subject, and skips one removed before its result', async () => {
    const files = new Map<string, string>();
    const { clean, removed, subject } = await inFirm(withIso.firmId, async (tx) => {
      const standard = await isoCatalogue.createStandard(tx, {
        code: 'ISO_9001',
        edition: '2015+A1:2024',
        title: 'ISO 9001',
        topic: 'Quality management',
      });
      await isoCatalogue.createClauses(tx, [
        {
          standardId: standard.id,
          number: '9.3',
          title: 'Clause 9.3',
          summary: 'Our own summary.',
          parentId: null,
          hlsKey: '9.3',
          assessable: true,
          exclusionAllowed: false,
        },
      ]);
      const system = await managementSystems.create(tx, {
        clientId: withIso.clientId,
        name: 'Stonebridge quality system',
        standardIds: [standard.id],
        scopeStatement: null,
        unitIds: [],
        status: 'PLANNING',
        reviewIntervalMonths: 12,
        climateChangeRelevant: null,
        climateChangeRationale: null,
        climateDecidedOn: null,
      });
      const [row] = await clauseAssessments.addForStandards(tx, system, [standard.id]);
      const subject = { type: 'clause_assessment' as const, id: row!.id };
      iso = { systemId: system.id, subject };
      const add = async (text: string) => {
        const storageKey = `evidence/${withIso.firmId}/${withIso.clientId}/iso/${randomUUID()}`;
        files.set(storageKey, text);
        return isoFiles.create(tx, {
          clientId: withIso.clientId,
          subject,
          fileName: 'review-minutes.pdf',
          mimeType: 'application/pdf',
          sizeBytes: text.length,
          sha256: 'b'.repeat(64),
          storageKey,
          uploadedById: withIso.ownerId,
        });
      };
      return {
        clean: await add('%PDF-1.7 minutes'),
        removed: await add('%PDF-1.7 draft'),
        subject,
      };
    });
    expect(
      (
        await deps.store.withFirm(withIso.firmId, 'req:iso', (tx) => tx.listPendingIsoFiles(200))
      ).map((f) => [f.id, f.subject]),
    ).toEqual([
      [clean.id, subject],
      [removed.id, subject],
    ]);

    let first = true;
    const scanDeps: JobDeps = {
      ...deps,
      scanner: {
        async scan(content) {
          for await (const chunk of content) void chunk;
          // The second file is removed while the first is scanned, after the queue was read.
          if (first) {
            first = false;
            await inFirm(withIso.firmId, (tx) =>
              isoFiles.archive(tx, removed.id, 'Uploaded in error'),
            );
          }
          return { status: 'CLEAN' };
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
    expect(await runScanEvidence(scanDeps, 'job:iso:scan')).toMatchObject({ clean: 1, failed: 0 });
    const stored = (id: string) => inFirm(withIso.firmId, (tx) => isoFiles.require(tx, id));
    expect((await stored(clean.id)).scanStatus).toBe('CLEAN');
    const kept = await stored(removed.id);
    expect(kept.scanStatus).toBe('PENDING');
    expect(kept.archivedAt).not.toBeNull();
    const trail = await inFirm(withIso.firmId, (tx) =>
      auditEvents.query(tx, { entityType: subject.type, entityId: subject.id, action: ['UPDATE'] }),
    );
    expect(trail.items).toEqual([
      expect.objectContaining({
        actorKind: 'SYSTEM',
        entityType: 'clause_assessment',
        entityId: subject.id,
        before: { fileId: clean.id, scanStatus: 'PENDING' },
        after: { fileId: clean.id, scanStatus: 'CLEAN' },
      }),
    ]);
    expect(await t.count(withIso.firmId, 'domain_event', `type = 'evidence.scanned'`)).toBe(0);

    await deps.store.withFirm(withIso.firmId, 'req:iso', async (tx) => {
      // A failed attempt is read back from the subject's trail, for that file only.
      await tx.writeAudit([
        {
          clientId: withIso.clientId,
          at: NOW,
          requestId: 'req:iso',
          actorId: null,
          actorKind: 'SYSTEM',
          action: 'UPDATE',
          entityType: subject.type,
          entityId: subject.id,
          before: { fileId: removed.id, scanStatus: 'PENDING' },
          after: {
            fileId: removed.id,
            scanStatus: 'PENDING',
            scanAttempt: 1,
            scanError: 'UNREADABLE',
          },
          reason: null,
        },
      ]);
      expect(await tx.isoScanAttempts(removed.id, subject)).toBe(1);
      expect(await tx.isoScanAttempts(clean.id, subject)).toBe(0);
      expect(await tx.listPendingIsoFiles(200)).toEqual([]);
      expect(await tx.recordIsoScan(removed.id, 'CLEAN')).toBe(false);
    });
    // Another account sees none of these files.
    expect(
      await deps.store.withFirm(lawOnly.firmId, 'req:iso', (tx) =>
        tx.recordIsoScan(clean.id, 'INFECTED'),
      ),
    ).toBe(false);
  });

  it('keeps the status of a file removed between the scan read and its write', async () => {
    const file = await inFirm(withIso.firmId, (tx) =>
      isoFiles.create(tx, {
        clientId: withIso.clientId,
        subject: iso.subject,
        fileName: 'audit-plan.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 8,
        sha256: 'c'.repeat(64),
        storageKey: `evidence/${withIso.firmId}/${withIso.clientId}/iso/${randomUUID()}`,
        uploadedById: withIso.ownerId,
      }),
    );
    // The remove holds the row while the scan's write runs, and commits after the write has read the file as PENDING.
    let removing!: () => void;
    const removed = new Promise<void>((resolve) => (removing = resolve));
    let commit!: () => void;
    const committed = new Promise<void>((resolve) => (commit = resolve));
    const remove = inFirm(withIso.firmId, async (tx) => {
      await isoFiles.archive(tx, file.id, 'Uploaded in error');
      removing();
      await committed;
    });
    await removed;
    const write = deps.store.withFirm(withIso.firmId, 'req:iso', (tx) =>
      tx.recordIsoScan(file.id, 'CLEAN'),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    commit();
    await remove;
    expect(await write).toBe(false);
    const kept = await inFirm(withIso.firmId, (tx) => isoFiles.require(tx, file.id));
    expect(kept.scanStatus).toBe('PENDING');
    expect(kept.archivedAt).not.toBeNull();
  });

  it('sends each ISO reminder once per subject from the send log, in the account only', async () => {
    const TODAY = '2026-10-12' as LocalDate;
    const subjects = await inFirm(withIso.firmId, async (tx) => {
      // The catalogue copy is recorded: the add-on is served from here on.
      expect(await accountJobs.markIsoCatalogueCopied(tx)).toBe(true);
      const risk = await riskItems.create(tx, {
        clientId: withIso.clientId,
        managementSystemId: iso.systemId,
        kind: 'RISK',
        unitId: null,
        activity: 'Casting',
        description: 'A late alloy delivery stops the line',
        impact: null,
        lifeCycleStages: [],
        controlType: null,
        routine: null,
        personsExposed: [],
        condition: null,
        assessedWith: null,
        likelihood: 3,
        severity: 4,
        residualLikelihood: null,
        residualSeverity: null,
        rating: 12,
        residualRating: null,
        significant: true,
        significantOverride: null,
        significanceReason: null,
        obligationIds: [],
        climateRelated: false,
        ownerId: withIso.ownerId,
        reviewDueOn: TODAY,
        lastReviewedOn: null,
      });
      const action = (text: string) =>
        isoActions.create(tx, {
          clientId: withIso.clientId,
          subject: { type: 'RISK_ITEM', id: risk.id },
          text,
          resources: null,
          ownerId: withIso.ownerId,
          dueOn: TODAY,
          doneOn: null,
          state: 'OPEN',
          effectivenessNote: null,
          cancelReason: null,
          controlHierarchy: null,
          outputKey: null,
        });
      const first = await action('Qualify a second alloy supplier');
      const second = await action('Hold two weeks of alloy stock');
      const document = await controlledDocuments.create(tx, {
        clientId: withIso.clientId,
        managementSystemId: iso.systemId,
        code: 'QP-07',
        title: 'Calibration procedure',
        type: 'PROCEDURE',
        clauseIds: [],
        status: 'ACTIVE',
        currentRevisionId: null,
        ownerId: withIso.ownerId,
        approverId: withIso.ownerId,
        reviewDueOn: TODAY,
        lastReviewedOn: null,
        retention: null,
        issuer: null,
        externalRef: null,
      });
      return [risk.id, first.id, second.id, document.id];
    });
    const mailer = captureMailer();
    const run = { ...deps, mailer };
    expect(await runIsoReminders(run, 'job:iso:remind:1')).toMatchObject({ firms: 1, sent: 4 });
    expect(mailer.sent.map((m) => m.subject).sort()).toEqual([
      'Due today: Hold two weeks of alloy stock',
      'Due today: Qualify a second alloy supplier',
      'Review due today: Casting',
      'Review due today: QP-07 Calibration procedure',
    ]);
    expect(await runIsoReminders(run, 'job:iso:remind:2')).toMatchObject({
      sent: 0,
      alreadySent: 4,
    });
    expect(mailer.sent).toHaveLength(4);
    expect(
      await t.count(withIso.firmId, 'notification_send', 'iso_subject_id = ANY($1::uuid[])', [
        subjects,
      ]),
    ).toBe(4);
    expect(
      await t.count(
        withIso.firmId,
        'domain_event',
        `type = 'notification.sent' AND data ? 'isoSubjectId'`,
      ),
    ).toBe(4);
    const done = await deps.store.withFirm(withIso.firmId, 'req:iso', (tx) =>
      tx.listDoneIsoSends(withIso.clientId, TODAY),
    );
    expect(done.map((k) => k.isoSubjectId).sort()).toEqual([...subjects].sort());
    // The statutory done set leaves ISO rows out, and another account sees none of them.
    const statutory = await deps.store.withFirm(withIso.firmId, 'req:iso', (tx) =>
      tx.listDoneSends(withIso.clientId, TODAY),
    );
    expect(statutory.every((k) => k.instanceId !== null)).toBe(true);
    expect(
      await deps.store.withFirm(lawOnly.firmId, 'req:iso', (tx) =>
        tx.listDoneIsoSends(withIso.clientId, TODAY),
      ),
    ).toEqual([]);
  });
});
