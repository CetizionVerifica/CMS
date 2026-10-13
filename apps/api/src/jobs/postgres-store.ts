import { LocalDate } from '@canopy/contracts';
import {
  acts,
  assignments,
  auditEvents,
  departments,
  domainEvents,
  firms,
  instances,
  jobs,
  notificationSends,
  obligations,
  units,
  systemContext,
  type Database,
  type TenantTx,
} from '@canopy/db';
import type { FirmTx, JobStore, NoticeInstance } from './ports.js';

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
