import { LocalDate } from '@canopy/contracts';
import {
  accountJobs,
  acts,
  assignments,
  auditEvents,
  clients,
  departments,
  domainEvents,
  evidence,
  firms,
  instances,
  invites,
  jobs,
  notificationSends,
  obligations,
  people,
  units,
  systemContext,
  type Database,
  type TenantTx,
} from '@canopy/db';
import type {
  FirmTx,
  InviteNotice,
  JobStore,
  NoticeInstance,
  PendingEvidence,
  PersonNotice,
} from './ports.js';

/**
 * The jobs' ports on M3's repositories. Every firm runs in `withTenant(systemContext(firmId, requestId))`, so RLS
 * scopes each row to that firm; `listFirmIds` is the one cross-tenant read and returns ids only.
 */
export function postgresJobStore(db: Database): JobStore {
  return {
    listFirmIds: () => db.listFirmIds(),
    withFirm: (firmId, requestId, fn) =>
      db.withTenant(systemContext(firmId, requestId), (tx) => fn(firmTx(tx))),
  };
}

function firmTx(tx: TenantTx): FirmTx {
  return {
    firmSettings: async () => (await firms.current(tx)).settings,
    accountStatus: async () => (await firms.current(tx)).status,
    endTrial: (now, job) => accountJobs.endTrial(tx, now, job),
    takeUsageSnapshot: (on) => accountJobs.takeUsageSnapshot(tx, on),
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
    // The instance's whole history is read, page by page, so a busy instance cannot hide an attempt.
    scanAttempts: async (evidenceId, instanceId) => {
      let attempts = 0;
      let after: string | undefined;
      do {
        const page = await auditEvents.query(tx, {
          entityType: 'instance',
          entityId: instanceId,
          action: ['UPDATE'],
          limit: 200,
          ...(after && { after }),
        });
        attempts += page.items.filter(
          (e) => e.after?.evidenceId === evidenceId && e.after?.scanStatus === 'PENDING',
        ).length;
        after = page.nextCursor ?? undefined;
      } while (after);
      return attempts;
    },
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
    listDoneDigests: (sendDate) => notificationSends.listDoneDigests(tx, sendDate),
    recipients: (personIds, clientId) => jobs.recipients(tx, personIds, clientId),
    listConsultants: () => jobs.listConsultants(tx),
    listScoreItems: (clientId, range) => jobs.listScoreItems(tx, clientId, range),
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
