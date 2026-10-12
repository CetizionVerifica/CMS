import {
  ExportJob,
  Id,
  Instant,
  LocalDate,
  NotificationKind,
  type JobStatus,
} from '@canopy/contracts';
import { and, asc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TenantTx } from '../database.js';
import { DbError, rethrow, validate } from '../errors.js';
import * as s from '../schema/index.js';
import { entity } from './crud.js';

/** Outbox, exports and the notification send log. */

/** A domain event to publish (events.md §2). `data` carries ids and enums only, never personal data. */
export const NewDomainEvent = z.strictObject({
  type: z.string().regex(/^[a-z_]+\.[a-z_]+$/),
  clientId: Id.nullable(),
  actor: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('PERSON'), personId: Id }),
    z.strictObject({ kind: z.literal('SYSTEM'), job: z.string().min(1) }),
    z.strictObject({ kind: z.literal('IMPORT'), batchId: Id }),
  ]),
  requestId: z.string().min(1).max(200),
  aggregate: z.strictObject({ type: z.string().min(1), id: Id }),
  aggregateVersion: z.int().min(1),
  data: z.record(z.string(), z.unknown()),
});
export type NewDomainEvent = z.infer<typeof NewDomainEvent>;

/** An outbox row as the relay reads it, in the events.md envelope. */
export interface OutboxEvent extends NewDomainEvent {
  id: string;
  schemaVersion: number;
  occurredAt: string;
  firmId: string;
  attempts: number;
}

export const domainEvents = {
  /** Adds an event to the outbox in the caller's transaction. No RETURNING (see auditEvents.append). */
  async enqueue(tx: TenantTx, event: NewDomainEvent): Promise<void> {
    const e = validate(NewDomainEvent, event);
    await tx
      .insert(s.domainEvent)
      .values({
        type: e.type,
        clientId: e.clientId,
        actor: e.actor,
        requestId: e.requestId,
        aggregateType: e.aggregate.type,
        aggregateId: e.aggregate.id,
        aggregateVersion: e.aggregateVersion,
        data: e.data,
      })
      .catch(rethrow);
  },
  /**
   * Locks up to `limit` unpublished events, oldest first, skipping rows another relay holds. Use in a
   * firm-wide system context and mark them published in the same transaction.
   */
  async claimUnpublished(tx: TenantTx, limit = 100): Promise<OutboxEvent[]> {
    const rows = await tx
      .select()
      .from(s.domainEvent)
      .where(isNull(s.domainEvent.publishedAt))
      .orderBy(asc(s.domainEvent.occurredAt), asc(s.domainEvent.id))
      .limit(limit)
      .for('update', { skipLocked: true })
      .catch(rethrow);
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      schemaVersion: r.schemaVersion,
      occurredAt: r.occurredAt.toISOString(),
      firmId: r.firmId,
      clientId: r.clientId,
      actor: r.actor as NewDomainEvent['actor'],
      requestId: r.requestId,
      aggregate: { type: r.aggregateType, id: r.aggregateId },
      aggregateVersion: r.aggregateVersion,
      data: r.data,
      attempts: r.attempts,
    }));
  },
  async markPublished(tx: TenantTx, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await tx
      .update(s.domainEvent)
      .set({ publishedAt: sql`now()` })
      .where(inArray(s.domainEvent.id, [...ids]))
      .catch(rethrow);
  },
  async recordFailure(tx: TenantTx, id: string): Promise<void> {
    await tx
      .update(s.domainEvent)
      .set({ attempts: sql`${s.domainEvent.attempts} + 1` })
      .where(eq(s.domainEvent.id, id))
      .catch(rethrow);
  },
};

const exportEntity = entity<
  ExportJob,
  Pick<ExportJob, 'clientId' | 'kind' | 'params' | 'requestedById'>
>({ table: s.exportJob, schema: ExportJob, omit: ['storageKey'] });

export const exportJobs = {
  get: exportEntity.get,
  require: exportEntity.require,
  create: exportEntity.create,
  setStatus: (
    tx: TenantTx,
    id: string,
    patch: { status: JobStatus; fileName?: string | null; storageKey?: string | null },
  ): Promise<ExportJob> => exportEntity.set(tx, id, patch),
  /** Where the finished file is stored. For the download step only; never returned to clients. */
  async storageKey(tx: TenantTx, id: string): Promise<string | null> {
    const [row] = await tx
      .select({ storageKey: s.exportJob.storageKey })
      .from(s.exportJob)
      .where(eq(s.exportJob.id, id))
      .catch(rethrow);
    return row?.storageKey ?? null;
  },
};

export const NotificationSend = z
  .strictObject({
    /** Null only for an event-driven send with no client (a magic link, a firm-role invite). */
    clientId: Id.nullable(),
    instanceId: Id.nullable(),
    recipientId: Id,
    kind: NotificationKind,
    sendDate: LocalDate,
    /**
     * Set for an event-driven send (the domain event's id): the send is then keyed on event and
     * recipient, so each event reaches each recipient once whatever the date. Absent or null for
     * scheduled sends, keyed on instance, kind, date and recipient.
     */
    eventId: Id.nullable().optional(),
  })
  .refine((n) => n.clientId !== null || (n.eventId != null && n.instanceId === null), {
    message: 'A send without a client answers an event and names no instance',
    path: ['clientId'],
  });
export type NotificationSend = z.input<typeof NotificationSend>;

/**
 * NEW: this call created the send-log row. PENDING: a row exists with no outcome (an earlier run crashed
 * before recording it), so send again. DONE: sent or failed for good; skip.
 */
export type ClaimResult = 'NEW' | 'PENDING' | 'DONE';

/** Why a notification was not sent. Stored on the send log; never the address or the message. */
export const SendFailureCode = z.enum(['NO_EMAIL', 'NOT_ACTIVE']);
export type SendFailureCode = z.infer<typeof SendFailureCode>;

/** The send-log row for a key: per instance, kind, date and recipient; digests have no instance. */
function sendKey(n: NotificationSend) {
  if (n.eventId) {
    return and(
      eq(s.notificationSend.eventId, n.eventId),
      eq(s.notificationSend.recipientId, n.recipientId),
    );
  }
  return and(
    isNull(s.notificationSend.eventId),
    eq(s.notificationSend.kind, n.kind),
    eq(s.notificationSend.sendDate, n.sendDate),
    eq(s.notificationSend.recipientId, n.recipientId),
    n.instanceId === null
      ? isNull(s.notificationSend.instanceId)
      : eq(s.notificationSend.instanceId, n.instanceId),
  );
}

export const notificationSends = {
  /** Claims a send so reminders never repeat; see ClaimResult. */
  async claim(tx: TenantTx, send: NotificationSend): Promise<ClaimResult> {
    const n = validate(NotificationSend, send);
    const created = await tx
      .insert(s.notificationSend)
      .values({ ...n, eventId: n.eventId ?? null })
      .onConflictDoNothing()
      .returning({ id: s.notificationSend.id })
      .catch(rethrow);
    if (created.length === 1) return 'NEW';
    const [row] = await tx
      .select({ sentAt: s.notificationSend.sentAt, failureCode: s.notificationSend.failureCode })
      .from(s.notificationSend)
      .where(sendKey(n))
      .catch(rethrow);
    return row && row.sentAt === null && row.failureCode === null ? 'PENDING' : 'DONE';
  },
  /**
   * Records that the send went out at `at` (ISO instant from the job clock) and returns the send-log row
   * id, which the caller's `notification.sent` event names as its aggregate (version 1).
   */
  async markSent(tx: TenantTx, send: NotificationSend, at: string): Promise<string> {
    const n = validate(NotificationSend, send);
    const [row] = await tx
      .update(s.notificationSend)
      .set({ sentAt: new Date(validate(Instant, at)), failureCode: null })
      .where(sendKey(n))
      .returning({ id: s.notificationSend.id })
      .catch(rethrow);
    if (!row) throw new DbError('NOT_FOUND', 'No claimed send for this key');
    return row.id;
  },
  /** Records that the send failed for good (no address, recipient not active). */
  async markFailed(tx: TenantTx, send: NotificationSend, code: SendFailureCode): Promise<void> {
    const n = validate(NotificationSend, send);
    await tx
      .update(s.notificationSend)
      .set({ sentAt: null, failureCode: validate(SendFailureCode, code) })
      .where(sendKey(n))
      .catch(rethrow);
  },
  /**
   * Recipients whose digest (no instance) for this date has an outcome, across the firm's clients.
   * Scheduled sends only, as in `listDone`; event-driven sends are keyed by event.
   */
  async listDoneDigests(tx: TenantTx, sendDate: string): Promise<string[]> {
    const t = s.notificationSend;
    const rows = await tx
      .selectDistinct({ id: t.recipientId })
      .from(t)
      .where(
        and(
          isNull(t.instanceId),
          isNull(t.eventId),
          eq(t.sendDate, validate(LocalDate, sendDate)),
          sql`(${t.sentAt} is not null or ${t.failureCode} is not null)`,
        ),
      )
      .orderBy(asc(t.recipientId))
      .catch(rethrow);
    return rows.map((r) => r.id);
  },
  /** Scheduled send-log rows of one client for one date with an outcome (sent or failed). */
  async listDone(tx: TenantTx, clientId: string, sendDate: string): Promise<NotificationSend[]> {
    const t = s.notificationSend;
    const rows = await tx
      .select({
        clientId: t.clientId,
        instanceId: t.instanceId,
        recipientId: t.recipientId,
        kind: t.kind,
        sendDate: t.sendDate,
      })
      .from(t)
      .where(
        and(
          eq(t.clientId, clientId),
          isNull(t.eventId),
          eq(t.sendDate, validate(LocalDate, sendDate)),
          sql`(${t.sentAt} is not null or ${t.failureCode} is not null)`,
        ),
      )
      .orderBy(asc(t.id))
      .catch(rethrow);
    return rows.map((r) => ({ ...r, kind: NotificationKind.parse(r.kind) }));
  },
};

/** A first response kept for replay under its Idempotency-Key (M7). */
export const IdempotencyRecord = z.strictObject({
  personId: Id,
  key: z.string().min(1).max(255),
  method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().regex(/^\//).max(2048),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  responseStatus: z.int().min(100).max(599),
  responseBody: z.json().nullable(),
  createdAt: Instant,
  expiresAt: Instant,
});
export type IdempotencyRecord = z.infer<typeof IdempotencyRecord>;

const idempotencyColumns = {
  personId: s.idempotencyKey.personId,
  key: s.idempotencyKey.key,
  method: s.idempotencyKey.method,
  path: s.idempotencyKey.path,
  requestHash: s.idempotencyKey.requestHash,
  responseStatus: s.idempotencyKey.responseStatus,
  responseBody: s.idempotencyKey.responseBody,
  createdAt: s.idempotencyKey.createdAt,
  expiresAt: s.idempotencyKey.expiresAt,
};

function toIdempotencyRecord(row: {
  [K in keyof typeof idempotencyColumns]: unknown;
}): IdempotencyRecord {
  return IdempotencyRecord.parse({
    ...row,
    createdAt: (row.createdAt as Date).toISOString(),
    expiresAt: (row.expiresAt as Date).toISOString(),
  });
}

export const idempotencyKeys = {
  /** The person's unexpired record for `key`, or null. An expired one is treated as absent. */
  async find(
    tx: TenantTx,
    personId: string,
    key: string,
    now: Date = new Date(),
  ): Promise<IdempotencyRecord | null> {
    const [row] = await tx
      .select(idempotencyColumns)
      .from(s.idempotencyKey)
      .where(
        and(
          eq(s.idempotencyKey.personId, personId),
          eq(s.idempotencyKey.key, key),
          gt(s.idempotencyKey.expiresAt, now),
        ),
      )
      .catch(rethrow);
    return row ? toIdempotencyRecord(row) : null;
  },
  /**
   * Stores the first response in the caller's transaction. An expired record for the same key is
   * replaced. DUPLICATE when an unexpired one exists, including one a concurrent request just committed
   * (the insert waits for it, then conflicts).
   */
  async record(tx: TenantTx, record: IdempotencyRecord): Promise<IdempotencyRecord> {
    const r = validate(IdempotencyRecord, record);
    const values = { ...r, createdAt: new Date(r.createdAt), expiresAt: new Date(r.expiresAt) };
    const [row] = await tx
      .insert(s.idempotencyKey)
      .values(values)
      .onConflictDoUpdate({
        target: [s.idempotencyKey.firmId, s.idempotencyKey.personId, s.idempotencyKey.key],
        set: {
          method: sql`excluded.method`,
          path: sql`excluded.path`,
          requestHash: sql`excluded.request_hash`,
          responseStatus: sql`excluded.response_status`,
          responseBody: sql`excluded.response_body`,
          createdAt: sql`excluded.created_at`,
          expiresAt: sql`excluded.expires_at`,
        },
        setWhere: sql`${s.idempotencyKey.expiresAt} <= excluded.created_at`,
      })
      .returning(idempotencyColumns)
      .catch(rethrow);
    if (!row) throw new DbError('DUPLICATE', 'DUPLICATE (idempotency_key.idempotency_key_key)');
    return toIdempotencyRecord(row);
  },
  /**
   * Deletes records that expired before `now`, up to `limit`, and returns how many went. For the M9 job
   * in each firm's system context; a person's context only reaches their own keys.
   */
  async purgeExpired(tx: TenantTx, now: Date, limit = 1000): Promise<number> {
    const doomed = tx
      .select({ id: s.idempotencyKey.id })
      .from(s.idempotencyKey)
      .where(lt(s.idempotencyKey.expiresAt, now))
      .orderBy(asc(s.idempotencyKey.expiresAt))
      .limit(limit);
    const result = await tx
      .delete(s.idempotencyKey)
      .where(inArray(s.idempotencyKey.id, doomed))
      .catch(rethrow);
    return result.rowCount ?? 0;
  },
};
