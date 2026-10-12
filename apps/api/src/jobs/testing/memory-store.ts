import { randomUUID } from 'node:crypto';
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_FIRM_SETTINGS,
  type ClientSettings,
  type Criticality,
  type FirmSettings,
  type Id,
  type LocalDate,
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
  JobAuditEvent,
  JobDomainEvent,
  JobStore,
  Mailer,
  OutgoingEmail,
  Recipient,
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

export interface MemorySend extends SendKey {
  sentAt: string | null;
  failureCode: SendFailureCode | null;
}

export interface MemoryFirm {
  id: Id;
  settings: FirmSettings;
  clients: ClientRef[];
  assignments: MemoryAssignment[];
  instances: MemoryInstance[];
  people: MemoryPerson[];
  sends: MemorySend[];
  audits: JobAuditEvent[];
  events: JobDomainEvent[];
}

export function memoryFirm(id: Id = randomUUID()): MemoryFirm {
  return {
    id,
    settings: structuredClone(DEFAULT_FIRM_SETTINGS) as FirmSettings,
    clients: [],
    assignments: [],
    instances: [],
    people: [],
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

const sameKey = (a: SendKey, b: SendKey) =>
  a.kind === b.kind &&
  a.sendDate === b.sendDate &&
  (a.instanceId === null
    ? b.instanceId === null && a.recipientId === b.recipientId
    : a.instanceId === b.instanceId);

function firmTx(firm: MemoryFirm, hooks: MemoryStoreHooks): FirmTx {
  const assignment = (id: Id) => firm.assignments.find((a) => a.assignmentId === id)!;
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
        });
        return id;
      });
    },
    writeAudit: async (events) => void firm.audits.push(...events),
    writeEvents: async (events) => void firm.events.push(...events),
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
        .map((i) => {
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
        }),
    listDoneSends: async (clientId, sendDate) =>
      firm.sends.filter(
        (s) =>
          s.clientId === clientId &&
          s.sendDate === sendDate &&
          (s.sentAt !== null || s.failureCode !== null),
      ),
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
        firm.sends.push({ ...key, sentAt: null, failureCode: null });
        return 'NEW';
      }
      return row.sentAt === null && row.failureCode === null ? 'PENDING' : 'DONE';
    },
    markSent: async (key, at, event) => {
      firm.sends.find((s) => sameKey(s, key))!.sentAt = at;
      firm.events.push(event);
    },
    markFailed: async (key, code) => {
      firm.sends.find((s) => sameKey(s, key))!.failureCode = code;
    },
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
