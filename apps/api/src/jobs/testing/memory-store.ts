import { randomUUID } from 'node:crypto';
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_FIRM_SETTINGS,
  type ClientSettings,
  type Criticality,
  type FirmSettings,
  type Id,
  type LocalDate,
  type Role,
  type SubmissionKind,
  type WorkflowState,
} from '@canopy/contracts';
import { compareDates } from '@canopy/engine';
import type {
  ClaimResult,
  ClientRef,
  ConsultantRef,
  FirmTx,
  GenerationTarget,
  InviteNotice,
  JobAuditEvent,
  JobDomainEvent,
  JobStore,
  Mailer,
  OutboxEvent,
  OutgoingEmail,
  PendingEvidence,
  PersonNotice,
  Recipient,
  ReminderCandidate,
  ScanResult,
  SendFailureCode,
  SendKey,
} from '../ports.js';

/** In-memory stand-in for the Postgres adapter, with the same rules the database enforces. */

export interface MemoryInstance {
  id: Id;
  assignmentId: Id;
  clientId: Id;
  periodStart: LocalDate;
  periodEnd: LocalDate;
  dueDate: LocalDate;
  workflowState: WorkflowState;
  pendingKind: SubmissionKind | null;
  completedOn: LocalDate | null;
  ownerId: Id;
  approverId: Id;
  archived: boolean;
  /** Optimistic-concurrency version; each change bumps it. */
  version: number;
}

export interface MemoryAssignment extends GenerationTarget {
  title: string;
  actName: string;
  unitName: string;
  departmentName: string;
  criticality: Criticality;
}

export interface MemoryPerson {
  id: Id;
  displayName: string;
  email: string | null;
  status: 'UNCLAIMED' | 'INVITED' | 'ACTIVE' | 'DISABLED';
  /** Clients the person holds a live membership in. */
  clientIds: Id[];
  consultantFor?: Id[];
}

export interface MemoryInvite {
  id: Id;
  personId: Id;
  email: string;
  role: Role;
  clientId: Id | null;
  createdById: Id;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

export interface MemoryEvidence extends PendingEvidence {
  scanStatus: 'PENDING' | ScanResult;
  archived: boolean;
  createdAt: string;
}

export interface MemorySend extends SendKey {
  id: Id;
  sentAt: string | null;
  failureCode: SendFailureCode | null;
}

/** An event any module wrote, as the outbox stores it. */
export type AnyDomainEvent = Omit<JobDomainEvent, 'type' | 'actor'> & {
  type: string;
  actor: Record<string, unknown>;
};

/** An outbox row: the event as written plus what the database adds. */
export interface MemoryOutboxEvent extends AnyDomainEvent {
  id: Id;
  occurredAt: string;
  publishedAt: string | null;
  attempts: number;
}

export interface MemoryFirm {
  id: Id;
  name: string;
  settings: FirmSettings;
  clients: ClientRef[];
  assignments: MemoryAssignment[];
  instances: MemoryInstance[];
  people: MemoryPerson[];
  invites: MemoryInvite[];
  evidence: MemoryEvidence[];
  sends: MemorySend[];
  audits: JobAuditEvent[];
  events: MemoryOutboxEvent[];
}

export function memoryFirm(id: Id = randomUUID()): MemoryFirm {
  return {
    id,
    name: 'Heron Compliance Partners',
    settings: structuredClone(DEFAULT_FIRM_SETTINGS) as FirmSettings,
    clients: [],
    assignments: [],
    instances: [],
    people: [],
    invites: [],
    evidence: [],
    sends: [],
    audits: [],
    events: [],
  };
}

export function memoryClient(name: string, settings: Partial<ClientSettings> = {}): ClientRef {
  return {
    id: randomUUID(),
    name,
    settings: { ...(structuredClone(DEFAULT_CLIENT_SETTINGS) as ClientSettings), ...settings },
  };
}

const inRange = (d: LocalDate, r: { from: LocalDate; to: LocalDate }) =>
  compareDates(d, r.from) >= 0 && compareDates(d, r.to) <= 0;

/**
 * The send-log dedupe key: instance, kind, send date and recipient (contracts NOTIFICATION_DEDUPE_KEY) for scheduled
 * sends; event and recipient for event-driven ones, as M3's partial unique indexes.
 */
const sameKey = (a: SendKey, b: SendKey) =>
  a.eventId || b.eventId
    ? a.eventId === b.eventId && a.recipientId === b.recipientId
    : a.kind === b.kind &&
      a.sendDate === b.sendDate &&
      a.recipientId === b.recipientId &&
      a.instanceId === b.instanceId;

function firmTx(firm: MemoryFirm, hooks: MemoryStoreHooks): FirmTx {
  const assignment = (id: Id) => firm.assignments.find((a) => a.assignmentId === id)!;
  const withNames = (i: MemoryInstance): ReminderCandidate => {
    const a = assignment(i.assignmentId);
    return {
      id: i.id,
      clientId: i.clientId,
      workflowState: i.workflowState,
      pendingKind: i.pendingKind,
      dueDate: i.dueDate,
      completedOn: i.completedOn,
      ownerId: i.ownerId,
      approverId: i.approverId,
      title: a.title,
      actName: a.actName,
      unitName: a.unitName,
      departmentName: a.departmentName,
      criticality: a.criticality,
    };
  };
  return {
    firmSettings: async () => firm.settings,
    listClients: async () => firm.clients,
    listGenerationTargets: async (clientId) =>
      firm.assignments.filter((a) => a.clientId === clientId),
    listInstanceKeys: async (ids, range) =>
      firm.instances
        .filter((i) => ids.includes(i.assignmentId) && inRange(i.dueDate, range))
        .map(({ assignmentId, periodStart, dueDate }) => ({ assignmentId, periodStart, dueDate })),
    insertInstances: async (rows) => {
      hooks.beforeInsert?.(rows.length);
      return rows.map((row) => {
        if (
          firm.instances.some(
            (i) => i.assignmentId === row.assignmentId && i.periodStart === row.periodStart,
          )
        ) {
          return null;
        }
        const id = randomUUID();
        firm.instances.push({
          ...row,
          id,
          workflowState: 'OPEN',
          pendingKind: null,
          completedOn: null,
          archived: false,
          version: 1,
        });
        return id;
      });
    },
    writeAudit: async (events) => void firm.audits.push(...events),
    writeEvents: async (events) => void firm.events.push(...events.map(outboxRow)),
    listReminderCandidates: async (clientId, range) =>
      firm.instances
        .filter(
          (i) =>
            i.clientId === clientId &&
            !i.archived &&
            ['OPEN', 'SENT_BACK', 'SUBMITTED'].includes(i.workflowState) &&
            inRange(i.dueDate, range) &&
            assignment(i.assignmentId).applicability === 'APPLICABLE',
        )
        .map(withNames),
    findInstance: async (instanceId) => {
      const found = firm.instances.find((i) => i.id === instanceId && !i.archived);
      return found ? { ...withNames(found), version: found.version } : null;
    },
    findPerson: async (personId): Promise<PersonNotice | null> => {
      const p = firm.people.find((x) => x.id === personId);
      return p
        ? { personId: p.id, displayName: p.displayName, email: p.email, status: p.status }
        : null;
    },
    listPendingEvidence: async (limit) =>
      firm.evidence
        .filter((e) => e.scanStatus === 'PENDING' && !e.archived)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .slice(0, limit)
        .map(({ id, clientId, instanceId, storageKey, sizeBytes }) => ({
          id,
          clientId,
          instanceId,
          storageKey,
          sizeBytes,
        })),
    scanAttempts: async (evidenceId, instanceId) =>
      firm.audits.filter(
        (a) =>
          a.entityType === 'instance' &&
          a.entityId === instanceId &&
          a.after?.evidenceId === evidenceId &&
          a.action === 'UPDATE' &&
          a.after?.scanStatus === 'PENDING',
      ).length,
    recordScan: async (evidenceId, scanStatus) => {
      const e = firm.evidence.find((x) => x.id === evidenceId);
      if (!e || e.archived || e.scanStatus !== 'PENDING') return null;
      e.scanStatus = scanStatus;
      return { instanceVersion: firm.instances.find((i) => i.id === e.instanceId)!.version };
    },
    findInvite: async (inviteId): Promise<InviteNotice | null> => {
      const i = firm.invites.find((x) => x.id === inviteId);
      if (!i) return null;
      const client = firm.clients.find((c) => c.id === i.clientId) ?? null;
      return {
        inviteId: i.id,
        personId: i.personId,
        email: i.email,
        firmName: firm.name,
        role: i.role,
        clientId: i.clientId,
        clientName: client?.name ?? null,
        clientTimeZone: client?.settings.timeZone ?? null,
        createdById: i.createdById,
        inviterName: firm.people.find((x) => x.id === i.createdById)?.displayName ?? '',
        expiresAt: i.expiresAt,
        acceptedAt: i.acceptedAt,
        revokedAt: i.revokedAt,
      };
    },
    listDoneSends: async (clientId, sendDate) =>
      firm.sends.filter(
        (s) =>
          !s.eventId &&
          s.clientId === clientId &&
          s.sendDate === sendDate &&
          (s.sentAt !== null || s.failureCode !== null),
      ),
    listDoneDigests: async (sendDate) =>
      firm.sends
        .filter(
          (s) =>
            !s.eventId &&
            s.kind === 'CONSULTANT_DIGEST' &&
            s.sendDate === sendDate &&
            (s.sentAt !== null || s.failureCode !== null),
        )
        .map((s) => s.recipientId),
    recipients: async (ids, clientId) =>
      firm.people
        .filter((p) => ids.includes(p.id))
        .map((p): Recipient => ({
          personId: p.id,
          displayName: p.displayName,
          email: p.email,
          canReceive: p.status === 'ACTIVE' && p.clientIds.includes(clientId),
        })),
    listConsultants: async () =>
      firm.people
        .filter((p) => p.consultantFor)
        .map((p): ConsultantRef => ({
          personId: p.id,
          displayName: p.displayName,
          email: p.email,
          canReceive: p.status === 'ACTIVE',
          clientIds: p.consultantFor!,
        })),
    listScoreItems: async (clientId, range) =>
      firm.instances
        .filter((i) => i.clientId === clientId && !i.archived && inRange(i.dueDate, range))
        .map((i) => ({
          instanceId: i.id,
          criticality: assignment(i.assignmentId).criticality,
          dueDate: i.dueDate,
          workflowState: i.workflowState,
          pendingKind: i.pendingKind,
          completedOn: i.completedOn,
        })),
    claimSend: async (key): Promise<ClaimResult> => {
      const row = firm.sends.find((s) => sameKey(s, key));
      if (!row) {
        firm.sends.push({ ...key, id: randomUUID(), sentAt: null, failureCode: null });
        return 'NEW';
      }
      return row.sentAt === null && row.failureCode === null ? 'PENDING' : 'DONE';
    },
    markSent: async (key, at, event) => {
      const row = firm.sends.find((s) => sameKey(s, key))!;
      row.sentAt = at;
      firm.events.push(
        outboxRow({
          ...event,
          aggregate: { type: 'notification_send', id: row.id },
          aggregateVersion: 1,
        }),
      );
    },
    markFailed: async (key, code) => {
      firm.sends.find((s) => sameKey(s, key))!.failureCode = code;
    },
    claimEvents: async (limit) =>
      firm.events
        .filter((e) => e.publishedAt === null)
        .slice(0, limit)
        .map((e): OutboxEvent => ({
          id: e.id,
          type: e.type,
          schemaVersion: 1,
          occurredAt: e.occurredAt,
          firmId: firm.id,
          clientId: e.clientId,
          actor: e.actor,
          requestId: e.requestId,
          aggregate: e.aggregate,
          aggregateVersion: e.aggregateVersion,
          data: e.data,
        })),
    markEventsPublished: async (ids) => {
      for (const e of firm.events) if (ids.includes(e.id)) e.publishedAt = new Date().toISOString();
    },
    recordEventFailure: async (id) => {
      const e = firm.events.find((x) => x.id === id);
      if (e) e.attempts += 1;
    },
  };
}

/** What the outbox adds to an event on insert. */
export function outboxRow(event: AnyDomainEvent): MemoryOutboxEvent {
  return {
    ...event,
    id: randomUUID(),
    occurredAt: new Date().toISOString(),
    publishedAt: null,
    attempts: 0,
  };
}

export interface MemoryStoreHooks {
  /** Called before an insert, e.g. to throw and test rollback. */
  beforeInsert?: (rows: number) => void;
}

export interface MemoryStore extends JobStore {
  firms: MemoryFirm[];
  /** Number of `withFirm` transactions, to check batching. */
  transactions: number;
}

/** A store over `firms`. Each `withFirm` works on a copy and commits it only when `fn` resolves. */
export function memoryStore(firms: MemoryFirm[], hooks: MemoryStoreHooks = {}): MemoryStore {
  const store: MemoryStore = {
    firms,
    transactions: 0,
    listFirmIds: async () => firms.map((f) => f.id),
    async withFirm(firmId, _requestId, fn) {
      store.transactions += 1;
      const index = firms.findIndex((f) => f.id === firmId);
      if (index < 0) throw new Error('No such firm');
      const draft = structuredClone(firms[index]!);
      const result = await fn(firmTx(draft, hooks));
      firms[index] = draft;
      return result;
    },
  };
  return store;
}

export interface CaptureMailer extends Mailer {
  sent: OutgoingEmail[];
  /** Makes the next `n` sends throw, like a transport outage. */
  failNext(n: number): void;
}

export function captureMailer(): CaptureMailer {
  let failures = 0;
  const mailer: CaptureMailer = {
    sent: [],
    failNext: (n) => void (failures = n),
    async send(email) {
      if (failures > 0) {
        failures -= 1;
        throw new Error('SMTP unavailable');
      }
      mailer.sent.push(email);
    },
  };
  return mailer;
}
