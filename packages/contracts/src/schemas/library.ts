import { z } from 'zod';
import {
  ActKind,
  Criticality,
  Jurisdiction,
  ObligationDomain,
  RuleStatus,
  TimelineType,
} from '../enums.js';
import {
  baseShape,
  ClauseNumber,
  Id,
  LocalDate,
  LongText,
  MonthDay,
  Month,
  Name,
  StateCode,
  Text,
  versionedShape,
} from '../primitives.js';

/** Library: Acts, categories, obligations and recurrence rules (docs/contracts/domain-model.md §4). */

/** STATE needs a stateCode; CENTRAL has none (README decision 9). */
export function checkJurisdiction(
  value: { jurisdiction: Jurisdiction; stateCode: string | null },
  ctx: z.core.$RefinementCtx,
): void {
  if (value.jurisdiction === 'STATE' && value.stateCode === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['stateCode'],
      message: 'A STATE jurisdiction needs a stateCode',
    });
  }
  if (value.jurisdiction === 'CENTRAL' && value.stateCode !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['stateCode'],
      message: 'A CENTRAL jurisdiction has no stateCode',
    });
  }
}

export const Act = z
  .strictObject({
    ...baseShape,
    ...versionedShape,
    name: Name,
    shortName: Name.nullable(),
    jurisdiction: Jurisdiction,
    stateCode: StateCode.nullable(),
    /** Other spellings that resolve to this Act on import. */
    aliases: z.array(Name),
    /**
     * STATUTE (a law) or STANDARD (an ISO management-system standard, ADR M16-0001). Optional until M3 stores it: a
     * reader treats a missing kind as STATUTE. A STANDARD act is CENTRAL with no stateCode.
     */
    kind: ActKind.optional(),
  })
  .superRefine(checkJurisdiction)
  .refine((a) => a.kind !== 'STANDARD' || a.jurisdiction === 'CENTRAL', {
    path: ['jurisdiction'],
    message: 'A STANDARD act is CENTRAL',
  });
export type Act = z.infer<typeof Act>;

export const Category = z.strictObject({
  ...baseShape,
  ...versionedShape,
  name: Name,
  aliases: z.array(Name),
});
export type Category = z.infer<typeof Category>;

const Anchor = z.enum(['PERIOD_END', 'AFTER_PERIOD_END']);
const DaysAfter = z.int().min(0).max(366);

/**
 * Recurrence rule. M4 owns the semantics (packages/engine/CLAUDE.md); the shape is fixed here.
 */
export const RecurrenceRule = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('ONE_TIME'), dueDate: LocalDate }),
    /** e.g. TDS deposit: day 7 of the following month is `{ day: 7, offsetMonths: 1 }`. */
    z.strictObject({
      kind: z.literal('MONTHLY'),
      day: z.union([z.int().min(1).max(31), z.literal('LAST')]),
      offsetMonths: z.union([z.literal(0), z.literal(1)]),
    }),
    z.strictObject({ kind: z.literal('QUARTERLY'), anchor: Anchor, days: DaysAfter }),
    z.strictObject({ kind: z.literal('HALF_YEARLY'), anchor: Anchor, days: DaysAfter }),
    z.strictObject({ kind: z.literal('ANNUAL'), month: Month, day: z.int().min(1).max(31) }),
    /** e.g. employment exchange return: 30 Apr, 30 Jul, 30 Oct, 30 Jan. */
    z.strictObject({ kind: z.literal('FIXED_DATES'), dates: z.array(MonthDay).min(1).max(24) }),
    z.strictObject({
      kind: z.literal('ONGOING_REVIEW'),
      every: z.enum(['MONTH', 'QUARTER', 'HALF_YEAR', 'YEAR']),
    }),
    z.strictObject({
      kind: z.literal('EVENT_DRIVEN'),
      trigger: Text.max(300),
      withinDays: z.int().min(0).max(3650),
    }),
  ])
  .superRefine((rule, ctx) => {
    if (
      rule.kind === 'ANNUAL' &&
      !MonthDay.safeParse({ month: rule.month, day: rule.day }).success
    ) {
      ctx.addIssue({ code: 'custom', path: ['day'], message: 'Day does not exist in that month' });
    }
  });
export type RecurrenceRule = z.infer<typeof RecurrenceRule>;
export type RecurrenceKind = RecurrenceRule['kind'];

export const GeneratedPeriod = z.strictObject({
  periodStart: LocalDate,
  periodEnd: LocalDate,
  dueDate: LocalDate,
});
export type GeneratedPeriod = z.infer<typeof GeneratedPeriod>;

export const InferredRule = z.strictObject({
  rule: RecurrenceRule,
  confidence: z.number().min(0).max(1),
  mismatches: z.array(z.strictObject({ expected: LocalDate, generated: LocalDate.nullable() })),
});
export type InferredRule = z.infer<typeof InferredRule>;

/** A form or log sheet. `fileName` set with `templateFileId` null means "file not attached". */
export const TemplateRef = z
  .strictObject({
    label: Text.max(500),
    fileName: Text.max(255).nullable(),
    templateFileId: Id.nullable(),
  })
  .refine((t) => t.templateFileId === null || t.fileName !== null, {
    message: 'An attached template needs a fileName',
    path: ['fileName'],
  });
export type TemplateRef = z.infer<typeof TemplateRef>;

export const Obligation = z
  .strictObject({
    ...baseShape,
    ...versionedShape,
    /** Raw source ID, e.g. "TAX-CL-033-6067-60218". Data, not a key. */
    externalRef: Text.max(100).nullable(),
    domain: ObligationDomain,
    jurisdiction: Jurisdiction,
    stateCode: StateCode.nullable(),
    actId: Id,
    categoryId: Id,
    /** Not unique. */
    title: Text.max(1000),
    /** Plain text with line breaks preserved. */
    description: LongText,
    applicabilityText: LongText.nullable(),
    criticality: Criticality,
    timelineType: TimelineType,
    recurrenceRule: RecurrenceRule,
    ruleStatus: RuleStatus,
    /** True blocks submit without CLEAN evidence. */
    evidenceRequired: z.boolean(),
    forms: z.array(TemplateRef),
    logSheets: z.array(TemplateRef),
    /** Bumped on every published change. */
    libraryVersion: z.int().min(1),
    /**
     * Clause numbers of the standard this activity serves, for obligations under a STANDARD act (ADR M16-0001), e.g.
     * `["7.1.5"]` for calibration. Optional until M3 stores it: a reader treats a missing list as empty.
     */
    clauseRefs: z.array(ClauseNumber).max(20).optional(),
  })
  .superRefine(checkJurisdiction)
  .superRefine((o, ctx) => {
    if (o.clauseRefs !== undefined && new Set(o.clauseRefs).size !== o.clauseRefs.length) {
      ctx.addIssue({ code: 'custom', path: ['clauseRefs'], message: 'Clause numbers repeat' });
    }
  });
export type Obligation = z.infer<typeof Obligation>;
