import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  baseColumns,
  clientPolicy,
  firmIdColumn,
  idColumn,
  instant,
  optionalClientPolicy,
} from './columns.js';
import { exportKindEnum, jobStatusEnum, notificationKindEnum } from './enums.js';
import { client, person } from './tenancy.js';
import { complianceInstance } from './work.js';

/** Outbox, exports and the notification send log. */

/**
 * Transactional outbox for the event catalogue (docs/contracts/events.md). Producers insert in the same
 * transaction as the change; the relay sets `published_at`. Payloads carry ids and enums, no personal data.
 */
export const domainEvent = pgTable(
  'domain_event',
  {
    id: idColumn(),
    firmId: firmIdColumn(),
    clientId: uuid('client_id'),
    type: text('type').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    occurredAt: instant('occurred_at').notNull().defaultNow(),
    actor: jsonb('actor').$type<Record<string, unknown>>().notNull(),
    requestId: text('request_id').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    aggregateVersion: integer('aggregate_version').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    publishedAt: instant('published_at'),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [
    foreignKey({
      name: 'domain_event_client_fk',
      columns: [t.firmId, t.clientId],
      foreignColumns: [client.firmId, client.id],
    }),
    index('domain_event_unpublished_idx')
      .on(t.occurredAt)
      .where(sql`published_at is null`),
    index('domain_event_aggregate_idx').on(t.aggregateType, t.aggregateId, t.aggregateVersion),
    check('domain_event_type_check', sql`type ~ '^[a-z_]+\\.[a-z_]+$'`),
    check('domain_event_attempts_check', sql`attempts >= 0`),
    optionalClientPolicy({ nullClientWrites: true }),
  ],
);

/** Excel and PDF exports generated off-request. */
export const exportJob = pgTable(
  'export_job',
  {
    ...baseColumns(),
    clientId: uuid('client_id').notNull(),
    kind: exportKindEnum('kind').notNull(),
    params: jsonb('params')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: jobStatusEnum('status').notNull().default('QUEUED'),
    fileName: text('file_name'),
    /** Where the finished file is stored; never returned to clients. */
    storageKey: text('storage_key'),
    requestedById: uuid('requested_by_id').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'export_job_client_fk',
      columns: [t.firmId, t.clientId],
      foreignColumns: [client.firmId, client.id],
    }),
    foreignKey({
      name: 'export_job_requested_by_fk',
      columns: [t.firmId, t.requestedById],
      foreignColumns: [person.firmId, person.id],
    }),
    index('export_job_client_idx').on(t.firmId, t.clientId, t.createdAt),
    clientPolicy(),
  ],
);

/**
 * One row per notification sent, so reminders are never sent twice: unique per instance, kind and send date,
 * and for digests (no instance) per recipient, kind and send date.
 */
export const notificationSend = pgTable(
  'notification_send',
  {
    id: idColumn(),
    firmId: firmIdColumn(),
    clientId: uuid('client_id').notNull(),
    instanceId: uuid('instance_id'),
    recipientId: uuid('recipient_id').notNull(),
    kind: notificationKindEnum('kind').notNull(),
    sendDate: date('send_date', { mode: 'string' }).notNull(),
    sentAt: instant('sent_at'),
    failureCode: text('failure_code'),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'notification_send_client_fk',
      columns: [t.firmId, t.clientId],
      foreignColumns: [client.firmId, client.id],
    }),
    foreignKey({
      name: 'notification_send_instance_fk',
      columns: [t.firmId, t.clientId, t.instanceId],
      foreignColumns: [
        complianceInstance.firmId,
        complianceInstance.clientId,
        complianceInstance.id,
      ],
    }),
    foreignKey({
      name: 'notification_send_recipient_fk',
      columns: [t.firmId, t.recipientId],
      foreignColumns: [person.firmId, person.id],
    }),
    uniqueIndex('notification_send_instance_key')
      .on(t.instanceId, t.kind, t.sendDate)
      .where(sql`instance_id is not null`),
    uniqueIndex('notification_send_digest_key')
      .on(t.recipientId, t.kind, t.sendDate)
      .where(sql`instance_id is null`),
    index('notification_send_client_idx').on(t.firmId, t.clientId, t.sendDate),
    clientPolicy(),
  ],
);
