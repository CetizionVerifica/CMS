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
import { baseColumns, firmWidePolicies, versionColumn } from './columns.js';
import {
  actKindEnum,
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
    /** STATUTE (a law) or STANDARD (an ISO management-system standard, ADR M16-0001). */
    kind: actKindEnum('kind').notNull().default('STATUTE'),
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
    check('act_standard_central_check', sql`kind <> 'STANDARD' or jurisdiction = 'CENTRAL'`),
    check('act_version_check', sql`version >= 1`),
    ...firmWidePolicies({ insert: 'staff' }),
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
    ...firmWidePolicies({ insert: 'staff' }),
  ],
);

/** A stored clause reference (the shape ISO-1 gives `Obligation.clauseRefs`). */
export interface ClauseRef {
  standard: 'ISO_9001' | 'ISO_14001' | 'ISO_45001';
  clauseNumber: string;
}

/**
 * An array of at most 20 distinct `{ standard, clauseNumber }` objects with no other keys, the standard a string from
 * the three, the clause number a string shaped as the contracts' `ClauseNumber`. Checked by an IMMUTABLE SQL function
 * (migration 0037) rather than jsonpath, whose lax mode unwraps nested arrays and array-valued keys.
 */
const clauseRefsCheck = sql`canopy_clause_refs_valid(clause_refs)`;

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
    /**
     * Clauses of the standards this activity serves (ADR M16-0001): `{ standard, clauseNumber }` objects, never bare
     * numbers, since one activity can serve 9001, 14001 and 45001 at once. Numbers only, no standard text.
     */
    clauseRefs: jsonb('clause_refs')
      .$type<ClauseRef[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
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
    check('obligation_clause_refs_check', clauseRefsCheck),
    check('obligation_version_check', sql`version >= 1`),
    ...firmWidePolicies({ insert: 'staff' }),
  ],
);
