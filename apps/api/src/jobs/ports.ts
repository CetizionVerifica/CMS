import type {
  AccountStatus,
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
 * M6's `copyMasterLibrary`: copies the master library into a new account in its own system context and records the
 * copy, once (ADR M15-0001 decision 8, ADR M6-0001). `copied` is false when it was already copied.
 */
export type LibraryCopier = (
  accountId: Id,
  requestId: string,
) => Promise<{ copied: boolean; categories: number; acts: number; obligations: number }>;

/**
 * M6's `copyIsoCatalogue` (ISO-9): copies the ISO catalogue into an account in its own system context, marking the copy
 * first in the same transaction (docs/iso/plan.md §4.3). `copied` is false when the account lacks `isoManagement`, was
 * already copied, or is not in TRIAL or ACTIVE (the marker sets nothing then).
 */
export type IsoCatalogueCopier = (accountId: Id, requestId: string) => Promise<{ copied: boolean }>;

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
  /** The account's status. The jobs that act for users serve TRIAL and ACTIVE accounts only (ADR M15-0001 decision 4). */
  accountStatus(): Promise<AccountStatus>;
  /**
   * The account's effective features (M3's `account.features`) and when the ISO catalogue was copied into it, or null
   * before (`account.isoCatalogueCopiedAt`). The ISO jobs skip an account whose copy is not recorded (docs/iso/plan.md
   * §4.3).
   */
  accountFeatures(): Promise<{ features: string[]; isoCatalogueCopiedAt: string | null }>;
  /**
   * Ends the trial when its last day is before `now`'s date in the account's time zone: SUSPENDED, with the
   * account's audit row, account.status_changed (actor SYSTEM, `job`) and the operator entry, all written by M3's
   * `app_end_trial`. True when it suspended the account.
   */
  endTrial(now: string, job: string): Promise<boolean>;
  /** Records the account's usage for `on`, replacing a snapshot already taken that day. */
  takeUsageSnapshot(on: LocalDate): Promise<void>;
  /**
   * Closes the support grants that ran out by `now`: the support person's membership and sessions end, and M3's
   * `app_record_support_expiry` writes SUPPORT_ACCESS_END to the operator trail. Returns how many it closed.
   */
  closeExpiredSupport(now: string): Promise<number>;
  /**
   * The last day of the account's latest paid subscription (the one that ends last), or null when it has none, for
   * the renewal email (M3's `app_subscription_ends_on`).
   */
  subscriptionEndsOn(): Promise<LocalDate | null>;
  /** The account's name and its trial's last day (null outside a trial), for the trial-ending email. */
  accountTrial(): Promise<{ name: string; trialEndsOn: LocalDate | null }>;
  /**
   * The account's admins (FIRM_ADMIN), non-archived people only; `canReceive` when the person is ACTIVE and holds a
   * FIRM_ADMIN membership that is unarchived and not expired at `now` (the job's clock).
   */
  listAccountAdmins(now: string): Promise<Recipient[]>;
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
  /** Failed scan attempts recorded for the file: its instance's `UPDATE` audit rows for it that left it PENDING. */
  scanAttempts(evidenceId: Id, instanceId: Id): Promise<number>;
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
  /** What the upload recorded; a CLEAN verdict counts only when every one of these bytes was scanned. */
  sizeBytes: number;
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
 * Storage or the scanner is down, so nothing is known about the file: the scan run stops and the attempt is not
 * counted against the file. Any other error a scanner or storage throws counts as a failed attempt on the file.
 */
export class ScanServiceError extends Error {
  override readonly name = 'ScanServiceError';
}

/** The scan of one file ran out of time (its deadline, or the scanner's own timeout). Counted, and the run stops. */
export class ScanTimeoutError extends Error {
  override readonly name = 'ScanTimeoutError';
}

/**
 * Storage stopped sending a file part-way. It may be the network or that one object, so the attempt is counted (one
 * bad object cannot hold up the queue for ever) and the run stops (an outage costs each file at most one attempt).
 */
export class ScanInterruptedError extends Error {
  override readonly name = 'ScanInterruptedError';
}

/**
 * A virus scanner (ClamAV's clamd by default, clamav-scanner.ts). Reads the whole file and stops when `signal`
 * aborts. Throws `ScanServiceError` when it cannot be reached and `ScanTimeoutError` when it runs out of time; the
 * file stays PENDING either way.
 */
export interface Scanner {
  scan(content: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<ScanVerdict>;
}

/**
 * Reads evidence bytes from object storage, stopping when `signal` aborts. Null when nothing is stored at the key.
 * Throws `ScanServiceError` when storage cannot be reached.
 */
export interface EvidenceObjects {
  open(storageKey: string, signal?: AbortSignal): Promise<AsyncIterable<Uint8Array> | null>;
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
  /** Needed by the `account.created` consumer, which throws without it. */
  copyLibrary?: LibraryCopier;
  /** Needed by the ISO catalogue copy (consumer and sweep), which throws without it when an account needs a copy. */
  copyIsoCatalogue?: IsoCatalogueCopier;
}

/** What every job returns, for logs and tests. Counts only; no names or addresses. */
export type JobReport = Record<string, number>;
