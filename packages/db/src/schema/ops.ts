import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
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
    /** The domain event an event-driven send answers (e.g. a send-back); null for scheduled sends. */
    eventId: uuid('event_id'),
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
    // events.md §3: one scheduled send per (instance, kind, date, recipient), so a reassigned owner
    // still gets theirs. Event-driven sends are one per (event, recipient) instead.
    uniqueIndex('notification_send_instance_key')
      .on(t.instanceId, t.kind, t.sendDate, t.recipientId)
      .where(sql`instance_id is not null and event_id is null`),
    uniqueIndex('notification_send_digest_key')
      .on(t.recipientId, t.kind, t.sendDate)
      .where(sql`instance_id is null and event_id is null`),
    uniqueIndex('notification_send_event_key')
      .on(t.firmId, t.eventId, t.recipientId)
      .where(sql`event_id is not null`),
    index('notification_send_client_idx').on(t.firmId, t.clientId, t.sendDate),
    clientPolicy(),
  ],
);

const ownOrStaff = sql`firm_id = app_firm_id() and (person_id = app_person_id() or app_firm_staff())`;

/**
 * Idempotency-Key replay for M7's state-changing routes: the first response to a person's key, kept until
 * `expires_at`. A person reaches their own keys; firm staff contexts (the M9 purge) reach the firm's.
 * The response body is what that person was already sent, so it stays behind the same RLS.
 */
export const idempotencyKey = pgTable(
  'idempotency_key',
  {
    id: idColumn(),
    firmId: firmIdColumn(),
    personId: uuid('person_id').notNull(),
    key: text('key').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    /** SHA-256 hex of the request, so a reused key with a different request can be refused. */
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body'),
    createdAt: instant('created_at').notNull(),
    expiresAt: instant('expires_at').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'idempotency_key_person_fk',
      columns: [t.firmId, t.personId],
      foreignColumns: [person.firmId, person.id],
    }),
    uniqueIndex('idempotency_key_key').on(t.firmId, t.personId, t.key),
    index('idempotency_key_expires_idx').on(t.firmId, t.expiresAt),
    check('idempotency_key_key_check', sql`length(key) between 1 and 255`),
    check('idempotency_key_method_check', sql`method in ('POST', 'PUT', 'PATCH', 'DELETE')`),
    check('idempotency_key_path_check', sql`path ~ '^/' and length(path) <= 2048`),
    check('idempotency_key_request_hash_check', sql`request_hash ~ '^[0-9a-f]{64}$'`),
    check('idempotency_key_status_check', sql`response_status between 100 and 599`),
    check('idempotency_key_expiry_check', sql`expires_at > created_at`),
    pgPolicy('tenant_isolation', {
      for: 'all',
      to: 'public',
      using: ownOrStaff,
      withCheck: ownOrStaff,
    }),
    // The one other DELETE grant (CLAUDE.md rule 6): only rows already expired can go.
    pgPolicy('delete_expired', {
      as: 'restrictive',
      for: 'delete',
      to: 'public',
      using: sql`firm_id = app_firm_id() and expires_at < now()`,
    }),
  ],
);
