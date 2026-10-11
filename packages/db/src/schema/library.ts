import type { RecurrenceRule, TemplateRef } from '@canopy/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns, firmPolicy, versionColumn } from './columns.js';
import {
  criticalityEnum,
  jurisdictionEnum,
  obligationDomainEnum,
  ruleStatusEnum,
  timelineTypeEnum,
} from './enums.js';

/** Library: Acts, categories and obligations, firm-wide (docs/contracts/domain-model.md §4). */

/** CENTRAL has no state code; STATE needs one (README decision 9). */
const jurisdictionCheck = sql`(jurisdiction = 'STATE') = (state_code is not null) and (state_code is null or state_code ~ '^[A-Z]{2,3}$')`;

export const act = pgTable(
  'act',
  {
    ...baseColumns(),
    version: versionColumn(),
    name: text('name').notNull(),
    shortName: text('short_name'),
    jurisdiction: jurisdictionEnum('jurisdiction').notNull(),
    stateCode: text('state_code'),
    aliases: text('aliases')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (t) => [
    unique('act_firm_key').on(t.firmId, t.id),
    uniqueIndex('act_name_key')
      .on(t.firmId, t.name)
      .where(sql`archived_at is null`),
    check('act_jurisdiction_check', jurisdictionCheck),
    check('act_version_check', sql`version >= 1`),
    firmPolicy(),
  ],
);

export const category = pgTable(
  'category',
  {
    ...baseColumns(),
    version: versionColumn(),
    name: text('name').notNull(),
    aliases: text('aliases')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (t) => [
    unique('category_firm_key').on(t.firmId, t.id),
    uniqueIndex('category_name_key')
      .on(t.firmId, t.name)
      .where(sql`archived_at is null`),
    check('category_version_check', sql`version >= 1`),
    firmPolicy(),
  ],
);

/** A requirement derived from an Act (Excel: one Compliance ID). `external_ref` is data, never a key. */
export const obligation = pgTable(
  'obligation',
  {
    ...baseColumns(),
    version: versionColumn(),
    externalRef: text('external_ref'),
    domain: obligationDomainEnum('domain').notNull(),
    jurisdiction: jurisdictionEnum('jurisdiction').notNull(),
    stateCode: text('state_code'),
    actId: uuid('act_id').notNull(),
    categoryId: uuid('category_id').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    applicabilityText: text('applicability_text'),
    criticality: criticalityEnum('criticality').notNull(),
    timelineType: timelineTypeEnum('timeline_type').notNull(),
    /** Shape validated with the contracts `RecurrenceRule` schema before every write. */
    recurrenceRule: jsonb('recurrence_rule').$type<RecurrenceRule>().notNull(),
    ruleStatus: ruleStatusEnum('rule_status').notNull(),
    evidenceRequired: boolean('evidence_required').notNull().default(false),
    forms: jsonb('forms')
      .$type<TemplateRef[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    logSheets: jsonb('log_sheets')
      .$type<TemplateRef[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    libraryVersion: integer('library_version').notNull().default(1),
  },
  (t) => [
    unique('obligation_firm_key').on(t.firmId, t.id),
    foreignKey({
      name: 'obligation_act_fk',
      columns: [t.firmId, t.actId],
      foreignColumns: [act.firmId, act.id],
    }),
    foreignKey({
      name: 'obligation_category_fk',
      columns: [t.firmId, t.categoryId],
      foreignColumns: [category.firmId, category.id],
    }),
    index('obligation_external_ref_idx').on(t.firmId, t.externalRef),
    index('obligation_act_idx').on(t.actId),
    index('obligation_category_idx').on(t.categoryId),
    check('obligation_jurisdiction_check', jurisdictionCheck),
    check(
      'obligation_recurrence_rule_check',
      sql`jsonb_typeof(recurrence_rule) = 'object' and recurrence_rule ? 'kind'`,
    ),
    check(
      'obligation_templates_check',
      sql`jsonb_typeof(forms) = 'array' and jsonb_typeof(log_sheets) = 'array'`,
    ),
    check('obligation_library_version_check', sql`library_version >= 1`),
    check('obligation_version_check', sql`version >= 1`),
    firmPolicy(),
  ],
);
