import { ExportJob, Id, LocalDate, NotificationKind, type JobStatus } from '@canopy/contracts';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TenantTx } from '../database.js';
import { rethrow, validate } from '../errors.js';
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

export const NotificationSend = z.strictObject({
  clientId: Id,
  instanceId: Id.nullable(),
  recipientId: Id,
  kind: NotificationKind,
  sendDate: LocalDate,
});
export type NotificationSend = z.input<typeof NotificationSend>;

export const notificationSends = {
  /**
   * Claims a send. True when this is the first claim for (instance, kind, send date), or for digests
   * (recipient, kind, send date); false when it was already sent or claimed, so reminders never repeat.
   */
  async claim(tx: TenantTx, send: NotificationSend): Promise<boolean> {
    const n = validate(NotificationSend, send);
    const rows = await tx
      .insert(s.notificationSend)
      .values(n)
      .onConflictDoNothing()
      .returning({ id: s.notificationSend.id })
      .catch(rethrow);
    return rows.length === 1;
  },
  async markSent(
    tx: TenantTx,
    send: NotificationSend,
    failureCode: string | null = null,
  ): Promise<void> {
    const n = validate(NotificationSend, send);
    await tx
      .update(s.notificationSend)
      .set({ sentAt: failureCode ? null : sql`now()`, failureCode })
      .where(
        and(
          eq(s.notificationSend.kind, n.kind),
          eq(s.notificationSend.sendDate, n.sendDate),
          n.instanceId === null
            ? and(
                isNull(s.notificationSend.instanceId),
                eq(s.notificationSend.recipientId, n.recipientId),
              )
            : eq(s.notificationSend.instanceId, n.instanceId),
        ),
      )
      .catch(rethrow);
  },
};
