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
  PersonStatus,
  Role,
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

/** An instance an event-driven email is about: the reminder fields plus its optimistic-concurrency version. */
export interface NoticeInstance extends ReminderCandidate {
  version: number;
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

/** A person a sign-in or invite email goes to. */
export interface PersonNotice {
  personId: Id;
  displayName: string;
  email: string | null;
  status: PersonStatus;
}

/** An invite with the names its email shows. */
export interface InviteNotice {
  inviteId: Id;
  personId: Id;
  /** The address the invite was sent to, which may differ from the person's. */
  email: string;
  firmName: string;
  role: Role;
  /** Null for a firm role. */
  clientId: Id | null;
  clientName: string | null;
  clientTimeZone: string | null;
  createdById: Id;
  inviterName: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

/**
 * M5's `AuthService.issueLoginToken`: stores a hash of a new one-time token and returns the raw value, which goes
 * into the email link only. It is never stored, logged or put in an event by the jobs.
 */
export type LoginTokenIssuer = (input: {
  firmId: Id;
  personId: Id;
  kind: 'MAGIC_LINK' | 'INVITE';
  inviteId?: Id;
}) => Promise<{ token: string; expiresAt: string }>;

/**
 * Dedupe key of the send log. Scheduled sends are unique per instance, kind, send date and recipient (digests:
 * recipient, kind, date). Event-driven sends carry the domain event's id and are unique per event and recipient
 * whatever the date (events.md §4 rule 4, `EVENT_NOTIFICATION_DEDUPE_KEY`; ADR M9-0001 §13), so a second send-back on the same day is its own email.
 */
export interface SendKey {
  /** Null only for event-driven sends that belong to no client: sign-in links and firm-role invites. */
  clientId: Id | null;
  instanceId: Id | null;
  recipientId: Id;
  kind: NotificationKind;
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
  type: 'instance.generated' | 'notification.sent' | 'evidence.scanned';
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
   * One non-archived instance with the names its email shows and its version, in any workflow state; null when it
   * is missing or archived. Event-driven sends read it to check the instance is still where the event left it.
   */
  findInstance(instanceId: Id): Promise<NoticeInstance | null>;
  /** One non-archived person; null when missing or archived. */
  findPerson(personId: Id): Promise<PersonNotice | null>;
  /** One invite in any state, with its client and inviter names; null when missing. */
  findInvite(inviteId: Id): Promise<InviteNotice | null>;
  /** Up to `limit` PENDING, non-archived evidence files of the firm, oldest upload first. */
  listPendingEvidence(limit: number): Promise<PendingEvidence[]>;
  /**
   * Sets a PENDING, non-archived file to its scan result and returns its instance's version, for the event. Null, and
   * nothing changed, when the file is missing, archived or no longer PENDING.
   */
  recordScan(evidenceId: Id, scanStatus: ScanResult): Promise<{ instanceVersion: number } | null>;
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

/** An evidence file waiting for its virus scan. The storage key is for reading the bytes, never logged. */
export interface PendingEvidence {
  id: Id;
  clientId: Id;
  instanceId: Id;
  storageKey: string;
}

/** A scan's outcome as stored: PENDING never comes out of a scan. */
export type ScanResult = 'CLEAN' | 'INFECTED' | 'FAILED';

/**
 * What a scanner found. FAILED means it cannot judge this file (too large for it, or the file is missing), so the file
 * stays out of reach; the person uploads it again.
 */
export type ScanVerdict =
  { status: 'CLEAN' } | { status: 'INFECTED'; signature: string } | { status: 'FAILED' };

/**
 * A virus scanner (ClamAV's clamd by default, clamav-scanner.ts). Reads the whole file. Throws when it could not scan
 * now (unreachable, timed out, an internal error); the file stays PENDING and the next run tries again.
 */
export interface Scanner {
  scan(content: AsyncIterable<Uint8Array>): Promise<ScanVerdict>;
}

/** Reads evidence bytes from object storage. Null when nothing is stored at the key. */
export interface EvidenceObjects {
  open(storageKey: string): Promise<AsyncIterable<Uint8Array> | null>;
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
  /** Needed by the sign-in link and invite emails, which throw without it. */
  issueLoginToken?: LoginTokenIssuer;
  /** The evidence scan job runs only with both. */
  scanner?: Scanner;
  evidenceObjects?: EvidenceObjects;
}

/** What every job returns, for logs and tests. Counts only; no names or addresses. */
export type JobReport = Record<string, number>;
