import { LocalDate, type EntityType, type Nonconformity } from '@canopy/contracts';
import { localDateIn } from '@canopy/engine';
import {
  account,
  accountJobs,
  actKindOf,
  acts,
  assignments,
  auditEvents,
  auditFindings,
  certifications,
  clients,
  controlledDocuments,
  departments,
  domainEvents,
  evidence,
  firms,
  externalAudits,
  instances,
  internalAudits,
  invites,
  isoActions,
  isoCatalogue,
  isoFiles,
  isoFileSubject,
  jobs,
  managementReviews,
  managementSystems,
  memberships,
  nonconformities,
  notificationSends,
  obligations,
  people,
  riskItems,
  supportGrants,
  units,
  systemContext,
  type Database,
  type TenantTx,
} from '@canopy/db';
import type {
  FirmTx,
  InviteNotice,
  IsoReminderData,
  JobStore,
  NoticeInstance,
  PendingEvidence,
  PendingIsoFile,
  PersonNotice,
} from './ports.js';

/**
 * The jobs' ports on M3's repositories. Every firm runs in `withTenant(systemContext(firmId, requestId))`, so RLS
 * scopes each row to that firm; `listFirmIds` is the one cross-tenant read and returns ids only.
 */
export function postgresJobStore(db: Database): JobStore {
  return {
    listFirmIds: () => db.listFirmIds(),
    listFirmIdsWithFeature: (flag) => db.listFirmIdsWithFeature(flag),
    withFirm: (firmId, requestId, fn) =>
      db.withTenant(systemContext(firmId, requestId), (tx) => fn(firmTx(tx))),
  };
}

const STANDARD = { actKinds: ['STANDARD'] } as const;

/** Failed scan attempts on one record's `UPDATE` audit rows, read page by page so a busy record cannot hide one. */
async function countAttempts(
  tx: TenantTx,
  entity: { entityType: EntityType; entityId: string },
  isAttempt: (after: Record<string, unknown>) => boolean,
): Promise<number> {
  let attempts = 0;
  let after: string | undefined;
  do {
    const page = await auditEvents.query(tx, {
      ...entity,
      action: ['UPDATE'],
      limit: 200,
      ...(after && { after }),
    });
    attempts += page.items.filter((e) => e.after !== null && isAttempt(e.after)).length;
    after = page.nextCursor ?? undefined;
  } while (after);
  return attempts;
}

/** Every page of a keyset list, 200 rows at a time. */
async function allPages<T>(
  read: (page: { limit: number; cursor: string | null }) => Promise<{
    items: T[];
    nextCursor: string | null;
  }>,
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | null = null;
  do {
    const page = await read({ limit: 200, cursor });
    rows.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return rows;
}

const CLOSED_NC: readonly string[] = ['CLOSED', 'CANCELLED'];

/**
 * One client's live ISO records in the shapes the reminders read. Internal audits and actions are read in the one state
 * that gets a reminder (PLANNED, OPEN); external audits and reviews in full, since the certification cycle and the
 * management review interval count the held ones. NCs are read for their approver and owner ids and their number,
 * never their description.
 */
async function isoReminderData(
  tx: TenantTx,
  clientId: string,
  now: string,
): Promise<IsoReminderData> {
  const { settings } = await clients.require(tx, clientId);
  const code = new Map((await isoCatalogue.standards(tx)).map((st) => [st.id, st.code]));
  const at = Date.parse(now);
  const clientAdminIds = [
    ...new Set(
      (await memberships.findAll(tx, { role: 'CLIENT_ADMIN', clientId }))
        .filter((m) => m.expiresAt === null || Date.parse(m.expiresAt) > at)
        .map((m) => m.personId),
    ),
  ].sort();

  const ncs = await allPages((p) => nonconformities.list(tx, clientId, p));
  const ncById = new Map<string, Nonconformity>(ncs.map((n) => [n.id, n]));
  const openNc = (id: string | null) => {
    const n = id === null ? undefined : ncById.get(id);
    return n && !CLOSED_NC.includes(n.state) ? n : undefined;
  };

  const actions = await allPages((p) => isoActions.list(tx, clientId, { ...p, state: ['OPEN'] }));
  const documents = await allPages((p) => controlledDocuments.list(tx, clientId, p));
  const risks = await allPages((p) => riskItems.list(tx, clientId, p));
  const audits = await allPages((p) =>
    internalAudits.list(tx, clientId, { ...p, state: ['PLANNED'] }),
  );
  const systems = await allPages((p) => managementSystems.list(tx, clientId, p));
  const certificates = await allPages((p) => certifications.list(tx, clientId, p));
  const external = await allPages((p) => externalAudits.list(tx, clientId, p));
  const reviews = await allPages((p) => managementReviews.list(tx, clientId, p));

  const responding = external.filter(
    (a) => a.responseDueOn !== null && (a.state === 'PLANNED' || a.state === 'HELD'),
  );
  const findings =
    responding.length === 0
      ? []
      : await allPages((p) =>
          auditFindings.list(tx, clientId, { ...p, externalAuditIds: responding.map((a) => a.id) }),
        );
  const ncOwners = new Map<string, Set<string>>();
  for (const f of findings) {
    const owner = openNc(f.nonconformityId)?.ownerId;
    if (owner === undefined || f.externalAuditId === null) continue;
    ncOwners.set(f.externalAuditId, (ncOwners.get(f.externalAuditId) ?? new Set()).add(owner));
  }
  const codes = (standardIds: string[]) =>
    standardIds.flatMap((id) => {
      const c = code.get(id);
      return c === undefined ? [] : [c];
    });

  return {
    clientAdminIds,
    actions: actions.map((a) => ({
      id: a.id,
      text: a.text,
      dueOn: a.dueOn,
      ownerId: a.ownerId,
      approverId:
        a.subject.type === 'NONCONFORMITY' ? (ncById.get(a.subject.id)?.approverId ?? null) : null,
    })),
    documents: documents.flatMap((d) =>
      d.reviewDueOn === null
        ? []
        : [
            {
              id: d.id,
              code: d.code,
              title: d.title,
              reviewDueOn: d.reviewDueOn,
              ownerId: d.ownerId,
              approverId: d.approverId,
            },
          ],
    ),
    risks: risks.flatMap((r) =>
      r.reviewDueOn === null
        ? []
        : [{ id: r.id, activity: r.activity, reviewDueOn: r.reviewDueOn, ownerId: r.ownerId }],
    ),
    internalAudits: audits.map((a) => ({
      id: a.id,
      title: a.title,
      state: a.state,
      plannedStart: a.plannedStart,
      leadAuditorId: a.leadAuditorId,
      auditorIds: a.auditorIds,
      auditeeIds: a.auditeeIds,
    })),
    systems: systems.map((m) => ({
      id: m.id,
      name: m.name,
      status: m.status,
      createdOn: localDateIn(m.createdAt, settings.timeZone),
      reviewIntervalMonths: m.reviewIntervalMonths,
      standards: codes(m.standardIds),
    })),
    certifications: certificates.flatMap((c) => {
      const standard = code.get(c.standardId);
      return standard === undefined
        ? []
        : [
            {
              id: c.id,
              managementSystemId: c.managementSystemId,
              standardId: c.standardId,
              standard,
              body: c.body,
              issuedOn: c.issuedOn,
              expiresOn: c.expiresOn,
            },
          ];
    }),
    externalAudits: external.map((a) => ({
      id: a.id,
      managementSystemId: a.managementSystemId,
      standardIds: a.standardIds,
      type: a.type,
      state: a.state,
      body: a.body,
      endOn: a.endOn,
      responseDueOn: a.responseDueOn,
      openNcOwnerIds: [...(ncOwners.get(a.id) ?? [])].sort(),
    })),
    reviews: reviews.map((r) => ({
      id: r.id,
      managementSystemId: r.managementSystemId,
      standards: r.standards,
      plannedOn: r.plannedOn,
      heldOn: r.heldOn,
      state: r.state,
      chairId: r.chairId,
    })),
    nonconformities: ncs.flatMap((n) =>
      n.effectivenessDueOn === null || CLOSED_NC.includes(n.state)
        ? []
        : [
            {
              id: n.id,
              number: n.number,
              state: n.state,
              effectivenessDueOn: n.effectivenessDueOn,
              approverId: n.approverId,
            },
          ],
    ),
  };
}

function firmTx(tx: TenantTx): FirmTx {
  return {
    firmSettings: async () => (await firms.current(tx)).settings,
    accountStatus: async () => (await firms.current(tx)).status,
    accountFeatures: async () => ({
      features: await account.features(tx),
      isoCatalogueCopiedAt: await account.isoCatalogueCopiedAt(tx),
    }),
    endTrial: (now, job) => accountJobs.endTrial(tx, now, job),
    takeUsageSnapshot: (on) => accountJobs.takeUsageSnapshot(tx, on),
    closeExpiredSupport: (now) => supportGrants.closeExpired(tx, now),
    subscriptionEndsOn: () => accountJobs.subscriptionEndsOn(tx),
    accountTrial: async () => {
      const firm = await firms.current(tx);
      return { name: firm.name, trialEndsOn: firm.trialEndsOn };
    },
    listAccountAdmins: async (now) => {
      const at = Date.parse(now);
      const admin = await memberships.findAll(tx, { role: 'FIRM_ADMIN' });
      if (admin.length === 0) return [];
      const live = new Set(
        admin
          .filter((m) => m.expiresAt === null || Date.parse(m.expiresAt) > at)
          .map((m) => m.personId),
      );
      const admins = await people.findAll(tx, { id: [...new Set(admin.map((m) => m.personId))] });
      return admins
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((p) => ({
          personId: p.id,
          displayName: p.displayName,
          email: p.email,
          canReceive: p.status === 'ACTIVE' && live.has(p.id),
        }));
    },
    standardObligationIds: async () => {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await obligations.list(
          tx,
          { limit: 200, cursor, includeArchived: true },
          STANDARD,
        );
        ids.push(...page.items.map((o) => o.id));
        cursor = page.nextCursor;
      } while (cursor !== null);
      return ids;
    },
    // One read per 1,000 ids (ISO-2j).
    standardInstanceIds: async (instanceIds) => {
      if (instanceIds.length === 0) return [];
      const kinds = await actKindOf.instances(tx, instanceIds);
      return instanceIds.filter((id) => kinds.get(id) === 'STANDARD');
    },
    listClients: () => jobs.listClients(tx),
    listGenerationTargets: (clientId) => jobs.listGenerationTargets(tx, clientId),
    listInstanceKeys: (assignmentIds, range) => jobs.listInstanceKeys(tx, assignmentIds, range),
    insertInstances: (rows) => jobs.insertInstances(tx, rows),
    // The database stamps the time when the row is written, inside the same transaction as the change.
    writeAudit: async (events) => {
      for (const { at, ...event } of events) {
        void at;
        await auditEvents.append(tx, event);
      }
    },
    writeEvents: async (events) => {
      for (const event of events) await domainEvents.enqueue(tx, event);
    },
    listReminderCandidates: (clientId, range) => jobs.listReminderCandidates(tx, clientId, range),
    findInstance: async (instanceId): Promise<NoticeInstance | null> => {
      const i = await instances.get(tx, instanceId);
      if (!i || i.archivedAt !== null) return null;
      const assignment = await assignments.require(tx, i.assignmentId);
      const obligation = await obligations.require(tx, assignment.obligationId);
      const act = await acts.require(tx, obligation.actId);
      const unit = await units.require(tx, i.unitId);
      const department = await departments.require(tx, assignment.departmentId);
      return {
        id: i.id,
        clientId: i.clientId,
        workflowState: i.workflowState,
        pendingKind: i.pendingKind,
        dueDate: i.dueDate,
        completedOn: i.completedOn,
        ownerId: i.ownerId,
        approverId: i.approverId,
        title: obligation.title,
        actName: act.name,
        unitName: unit.name,
        departmentName: department.name,
        criticality: obligation.criticality,
        version: i.version,
      };
    },
    findPerson: async (personId): Promise<PersonNotice | null> => {
      const p = await people.get(tx, personId);
      if (!p || p.archivedAt !== null) return null;
      return { personId: p.id, displayName: p.displayName, email: p.email, status: p.status };
    },
    // The vault lists one client newest first; pending files are few, so each client's are read in full and the
    // oldest kept.
    listPendingEvidence: async (limit): Promise<PendingEvidence[]> => {
      const found: { id: string; createdAt: string }[] = [];
      for (const client of await jobs.listClients(tx)) {
        let after: string | null = null;
        do {
          const page = await evidence.vault(tx, client.id, { scanStatus: ['PENDING'], after });
          found.push(...page.items);
          after = page.nextCursor;
        } while (after !== null);
      }
      found.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const oldest: PendingEvidence[] = [];
      for (const { id } of found.slice(0, limit)) {
        const e = await evidence.require(tx, id);
        oldest.push({
          id,
          clientId: e.clientId,
          instanceId: e.instanceId,
          storageKey: e.storageKey,
          sizeBytes: e.sizeBytes,
        });
      }
      return oldest;
    },
    recordScan: async (evidenceId, scanStatus) => {
      const e = await evidence.get(tx, evidenceId);
      if (!e || e.archivedAt !== null || e.scanStatus !== 'PENDING') return null;
      await evidence.setScanStatus(tx, evidenceId, scanStatus);
      return { instanceVersion: (await instances.require(tx, e.instanceId)).version };
    },
    scanAttempts: (evidenceId, instanceId) =>
      countAttempts(
        tx,
        { entityType: 'instance', entityId: instanceId },
        (a) => a.evidenceId === evidenceId && a.scanStatus === 'PENDING',
      ),
    listPendingIsoFiles: async (limit): Promise<PendingIsoFile[]> =>
      (await isoFiles.pendingScan(tx, limit)).map((f) => ({
        id: f.id,
        clientId: f.clientId,
        subject: isoFileSubject(f),
        storageKey: f.storageKey,
        sizeBytes: f.sizeBytes,
      })),
    // The UPDATE's own WHERE keeps a file removed, or already settled, since the scanner read it (ISO-2j).
    recordIsoScan: (fileId, scanStatus) => isoFiles.settleScan(tx, fileId, scanStatus),
    isoScanAttempts: (fileId, subject) =>
      countAttempts(
        tx,
        { entityType: subject.type, entityId: subject.id },
        (a) => a.fileId === fileId && a.scanStatus === 'PENDING',
      ),
    findInvite: async (inviteId): Promise<InviteNotice | null> => {
      const i = await invites.get(tx, inviteId);
      if (!i) return null;
      const client = i.grant.clientId === null ? null : await clients.get(tx, i.grant.clientId);
      const inviter = await people.get(tx, i.createdById);
      return {
        inviteId: i.id,
        personId: i.personId,
        email: i.email,
        firmName: i.firmName,
        role: i.grant.role,
        clientId: i.grant.clientId,
        clientName: client?.name ?? null,
        clientTimeZone: client?.settings.timeZone ?? null,
        createdById: i.createdById,
        inviterName: inviter?.displayName ?? '',
        expiresAt: i.expiresAt,
        acceptedAt: i.acceptedAt,
        revokedAt: i.revokedAt,
      };
    },
    listDoneSends: async (clientId, sendDate) =>
      (await notificationSends.listDone(tx, clientId, sendDate)).map((key) => ({
        ...key,
        sendDate: LocalDate.parse(key.sendDate),
      })),
    listDoneIsoSends: async (clientId, sendDate) =>
      (await notificationSends.listDoneIso(tx, clientId, sendDate)).map((key) => ({
        clientId: key.clientId,
        instanceId: null,
        recipientId: key.recipientId,
        kind: key.kind,
        sendDate: LocalDate.parse(key.sendDate),
        isoSubjectType: key.isoSubjectType,
        isoSubjectId: key.isoSubjectId,
      })),
    isoReminderData: (clientId, now) => isoReminderData(tx, clientId, now),
    listDoneDigests: (sendDate) => notificationSends.listDoneDigests(tx, sendDate),
    recipients: (personIds, clientId) => jobs.recipients(tx, personIds, clientId),
    listConsultants: () => jobs.listConsultants(tx),
    listScoreItems: (clientId, range, filter) => jobs.listScoreItems(tx, clientId, range, filter),
    claimSend: (key) => notificationSends.claim(tx, key),
    markSent: async (key, at, event) => {
      const id = await notificationSends.markSent(tx, key, at);
      await domainEvents.enqueue(tx, {
        ...event,
        aggregate: { type: 'notification_send', id },
        aggregateVersion: 1,
      });
    },
    markFailed: (key, code) => notificationSends.markFailed(tx, key, code),
    claimEvents: (limit) => domainEvents.claimUnpublished(tx, limit),
    markEventsPublished: (ids) => domainEvents.markPublished(tx, ids),
    recordEventFailure: (id) => domainEvents.recordFailure(tx, id),
  };
}
