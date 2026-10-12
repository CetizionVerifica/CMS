import type {
  AuditEvent,
  ClientSettings,
  Criticality,
  FirmSettings,
  Id,
  LocalDate,
  NotificationInput,
  NotificationKind,
  RecurrenceRule,
  RuleStatus,
  ScoreInput,
  Applicability,
} from '@canopy/contracts';
import type { RenderedEmail } from '@canopy/notifications';

/**
 * What the jobs need from the database, as narrow ports. The Postgres adapter maps each call onto M3's typed
 * repositories inside `Database.withTenant(systemContext(firmId, requestId))`, so RLS still scopes every row to
 * one firm. Tests use `testing/memory-store.ts`.
 */
export interface JobStore {
  /**
   * Every firm the jobs serve. The only cross-tenant read: it returns ids and nothing else, and each firm's work
   * then runs in its own tenant transaction.
   */
  listFirmIds(): Promise<Id[]>;
  /** Runs `fn` in one transaction for one firm (system context, all its clients). */
  withFirm<T>(firmId: Id, requestId: string, fn: (tx: FirmTx) => Promise<T>): Promise<T>;
}

export interface ClientRef {
  id: Id;
  name: string;
  settings: ClientSettings;
}

/** An assignment with what generation needs from its obligation. */
export interface GenerationTarget {
  assignmentId: Id;
  clientId: Id;
  applicability: Applicability;
  activeFrom: LocalDate;
  activeTo: LocalDate | null;
  ownerId: Id;
  approverId: Id;
  obligationId: Id;
  recurrenceRule: RecurrenceRule;
  ruleStatus: RuleStatus;
}

export interface ExistingInstanceKey {
  assignmentId: Id;
  periodStart: LocalDate;
  dueDate: LocalDate;
}

export interface NewInstance {
  assignmentId: Id;
  clientId: Id;
  periodStart: LocalDate;
  periodEnd: LocalDate;
  dueDate: LocalDate;
  ownerId: Id;
  approverId: Id;
}

/** An instance that may need a reminder, with the names its email shows. */
export interface ReminderCandidate extends NotificationInput {
  clientId: Id;
  title: string;
  actName: string;
  unitName: string;
  departmentName: string;
  criticality: Criticality;
}

export interface Recipient {
  personId: Id;
  displayName: string;
  /** Null while the person is unclaimed. */
  email: string | null;
  /** True when the person is ACTIVE and holds an unexpired, unarchived membership for the client. */
  canReceive: boolean;
}

export interface ConsultantRef {
  personId: Id;
  displayName: string;
  email: string | null;
  /** ACTIVE person with an unexpired, unarchived CONSULTANT membership. */
  canReceive: boolean;
  clientIds: Id[];
}

/**
 * Every kind the send log takes. The database enum already has APPROVAL_REQUESTED and SENT_BACK (M3 migration
 * 0017); contracts 1.4.0 adds them to `NotificationKind`, and this alias then becomes `NotificationKind`.
 */
export type SendKind = NotificationKind | 'APPROVAL_REQUESTED' | 'SENT_BACK';

/**
 * Dedupe key of the send log. Scheduled sends are unique per instance, kind, send date and recipient (digests:
 * recipient, kind, date). Event-driven sends carry the domain event's id and are unique per event and recipient
 * whatever the date (ADR M9-0001 §13), so a second send-back on the same day is its own email.
 */
export interface SendKey {
  clientId: Id;
  instanceId: Id | null;
  recipientId: Id;
  kind: SendKind;
  sendDate: LocalDate;
  /** The event an event-driven send answers; absent for scheduled sends. */
  eventId?: Id | null;
}

/**
 * NEW: this call created the row. PENDING: a row exists with no outcome (an earlier run crashed or the mail
 * transport failed before it was recorded), so send again. DONE: sent or failed for good; skip.
 */
export type ClaimResult = 'NEW' | 'PENDING' | 'DONE';

/** Audit row as the jobs write it; the store adds `id` and `firmId` from the tenant context. */
export type JobAuditEvent = Omit<AuditEvent, 'id' | 'firmId'>;

/** Outbox row (docs/contracts/events.md §2); the store adds `id`, `firmId` and `occurredAt`. */
export interface JobDomainEvent {
  type: 'instance.generated' | 'notification.sent';
  clientId: Id | null;
  actor: { kind: 'SYSTEM'; job: string };
  requestId: string;
  aggregate: { type: string; id: Id };
  aggregateVersion: number;
  data: Record<string, unknown>;
}

/**
 * An outbox row as the relay reads it: the events.md §2 envelope. The relay publishes it to the pg-boss queue
 * named after `type`, with the event id as the job id, so a re-published event is one job.
 */
export interface OutboxEvent {
  id: Id;
  type: string;
  schemaVersion: number;
  occurredAt: string;
  firmId: Id;
  clientId: Id | null;
  actor: Record<string, unknown>;
  requestId: string;
  aggregate: { type: string; id: Id };
  aggregateVersion: number;
  data: Record<string, unknown>;
}

/** `notification.sent` before the store fills in its aggregate (the send-log row). */
export type NotificationSentEvent = Omit<JobDomainEvent, 'aggregate' | 'aggregateVersion'> & {
  type: 'notification.sent';
};

export interface FirmTx {
  firmSettings(): Promise<FirmSettings>;
  /** Clients of the firm that are not archived. */
  listClients(): Promise<ClientRef[]>;
  /** Assignments of one client that are not archived. */
  listGenerationTargets(clientId: Id): Promise<GenerationTarget[]>;
  /** Instances of these assignments with a due date in the range. */
  listInstanceKeys(
    assignmentIds: Id[],
    range: { from: LocalDate; to: LocalDate },
  ): Promise<ExistingInstanceKey[]>;
  /**
   * Inserts with `ON CONFLICT (assignment_id, period_start) DO NOTHING` and returns the ids of the rows it
   * actually created, in input order, with `null` for rows that already existed.
   */
  insertInstances(rows: NewInstance[]): Promise<(Id | null)[]>;
  writeAudit(events: JobAuditEvent[]): Promise<void>;
  writeEvents(events: JobDomainEvent[]): Promise<void>;
  /**
   * Non-archived instances of one client in OPEN, SENT_BACK or SUBMITTED with a due date in the range, whose
   * assignment is APPLICABLE.
   */
  listReminderCandidates(
    clientId: Id,
    range: { from: LocalDate; to: LocalDate },
  ): Promise<ReminderCandidate[]>;
  /**
   * One non-archived instance with the names its email shows, in any workflow state; null when it is missing or
   * archived. Event-driven sends read it to check the instance is still where the event left it.
   */
  findInstance(instanceId: Id): Promise<ReminderCandidate | null>;
  /** Scheduled send-log rows of one client for one send date that are DONE (sent or failed). */
  listDoneSends(clientId: Id, sendDate: LocalDate): Promise<SendKey[]>;
  /** Recipients whose CONSULTANT_DIGEST for this send date is DONE (sent or failed), across all clients. */
  listDoneDigests(sendDate: LocalDate): Promise<Id[]>;
  recipients(personIds: Id[], clientId: Id): Promise<Recipient[]>;
  listConsultants(): Promise<ConsultantRef[]>;
  /** Score inputs of one client's non-archived instances with a due date in the range. */
  listScoreItems(clientId: Id, range: { from: LocalDate; to: LocalDate }): Promise<ScoreInput[]>;
  claimSend(key: SendKey): Promise<ClaimResult>;
  /**
   * Records the send and writes the `notification.sent` event in the same transaction. The store sets the event's
   * aggregate to the send-log row (`{ type: 'notification_send', id: <row id> }`, version 1): a row is sent at most
   * once, so each aggregate has exactly one event.
   */
  markSent(key: SendKey, at: string, event: NotificationSentEvent): Promise<void>;
  markFailed(key: SendKey, failureCode: SendFailureCode): Promise<void>;
  /**
   * Locks up to `limit` unpublished outbox events of the firm, oldest first, skipping rows another relay holds.
   * Mark them published in the same transaction.
   */
  claimEvents(limit: number): Promise<OutboxEvent[]>;
  markEventsPublished(ids: Id[]): Promise<void>;
  /** Counts a failed publish; the event stays unpublished and the next run tries again. */
  recordEventFailure(id: Id): Promise<void>;
}

/** Publishes an outbox event to its pg-boss queue. Idempotent on the event id. */
export interface EventBus {
  /** Event types that have a consumer; the relay marks every other type published without sending it. */
  consumes(type: string): boolean;
  publish(event: OutboxEvent): Promise<void>;
}

/** Why a notification was not sent. Stored on the send log, never the address or the message. */
export type SendFailureCode = 'NO_EMAIL' | 'NOT_ACTIVE';

export interface OutgoingEmail extends RenderedEmail {
  to: { name: string; email: string };
  /** Stable per send-log key so a transport that supports it can drop a duplicate. */
  idempotencyKey: string;
}

/** The mail transport. Throws on a transient failure; the job leaves the send PENDING and retries. */
export interface Mailer {
  send(email: OutgoingEmail): Promise<void>;
}

/** The current instant as an ISO UTC string ("2026-10-12T01:30:00.000Z"). Jobs never read the clock directly. */
export type Clock = () => string;

export interface JobDeps {
  store: JobStore;
  mailer: Mailer;
  clock: Clock;
  /** Public web origin for links in emails, e.g. "https://app.planetpulse.life". */
  appUrl: string;
  /** Set by the runner from pg-boss; the outbox relay needs it. */
  bus?: EventBus;
}

/** What every job returns, for logs and tests. Counts only; no names or addresses. */
export type JobReport = Record<string, number>;
