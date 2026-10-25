import { z } from 'zod';
import { FyLabel, Id, LocalDate } from '../primitives.js';
import { IsoStandardCode } from '../enums.js';
import { IncidentOutcome, IncidentType, ReviewInputSource } from './iso.js';

/**
 * Results of the ISO engine functions (docs/iso/model.md §5, M4), which the ISO API returns as they are. Every number
 * comes with the ids behind it, so a screen can list exactly the records it counts.
 */

const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;

/** A count and the ids it counts. */
export const IdCount = z
  .strictObject({ count: z.int().min(0), ids: z.array(Id) })
  .refine((c) => c.count === c.ids.length && unique(c.ids), {
    path: ['count'],
    message: 'count is the number of distinct ids',
  });
export type IdCount = z.infer<typeof IdCount>;

/** Where a dated ISO item stands: CLOSED once done, cancelled or closed, whatever its date. */
export const IsoTiming = z.enum(['ON_TIME', 'DUE_SOON', 'OVERDUE', 'CLOSED']);
export type IsoTiming = z.infer<typeof IsoTiming>;

/** `reviewDue`, `actionStatus` and part of `nonconformityStatus`. */
export const IsoDueStatus = z
  .strictObject({ timing: IsoTiming, overdueDays: z.int().min(1).nullable() })
  .refine((s) => (s.timing === 'OVERDUE') === (s.overdueDays !== null), {
    path: ['overdueDays'],
    message: 'overdueDays is set exactly when OVERDUE',
  });
export type IsoDueStatus = z.infer<typeof IsoDueStatus>;

/** `nonconformityStatus`: its due date, and whether the effectiveness check (`effectivenessDueOn`) is overdue. */
export const NonconformityStatus = z
  .strictObject({
    timing: IsoTiming,
    overdueDays: z.int().min(1).nullable(),
    effectivenessOverdueDays: z.int().min(1).nullable(),
  })
  .refine((s) => (s.timing === 'OVERDUE') === (s.overdueDays !== null), {
    path: ['overdueDays'],
    message: 'overdueDays is set exactly when OVERDUE',
  });
export type NonconformityStatus = z.infer<typeof NonconformityStatus>;

/**
 * Clause readiness of assessable clauses: IMPLEMENTED 1, PARTIAL 0.5, others 0. An approved N/A on a clause that allows
 * exclusion leaves the denominator (`excluded`); a requested one counts as not started (`naPending`). `score` is
 * 0-100 with one decimal, null when no clause counts.
 */
export const ReadinessScore = z.strictObject({
  score: z.number().min(0).max(100).nullable(),
  implemented: z.array(Id),
  partial: z.array(Id),
  notStarted: z.array(Id),
  naPending: z.array(Id),
  excluded: z.array(Id),
});
export type ReadinessScore = z.infer<typeof ReadinessScore>;

/** `clauseReadiness`: the whole system and each standard; the ids are clause ids. */
export const ClauseReadiness = z.strictObject({
  overall: ReadinessScore,
  byStandard: z.array(z.strictObject({ standardId: Id, ...ReadinessScore.shape })),
});
export type ClauseReadiness = z.infer<typeof ClauseReadiness>;

/** The stage-1 gates of `certificationReadiness` (model §5.1). */
export const CertificationGate = z.enum([
  'INTERNAL_AUDIT',
  'MANAGEMENT_REVIEW',
  'SCOPE',
  'POLICY',
  'OBJECTIVES',
  'RISKS',
]);
export type CertificationGate = z.infer<typeof CertificationGate>;

/** One gate: met, or what is missing (clause numbers, unit ids, input keys, objective ids or a risk kind). */
export const GateResult = z
  .strictObject({ gate: CertificationGate, met: z.boolean(), missing: z.array(z.string().min(1)) })
  .refine((g) => g.met === (g.missing.length === 0), {
    path: ['missing'],
    message: 'A gate is met exactly when nothing is missing',
  });
export type GateResult = z.infer<typeof GateResult>;

/** `certificationReadiness`: per standard of the system, every gate. From records, beside clause readiness. */
export const CertificationReadiness = z.strictObject({
  standards: z.array(
    z.strictObject({
      standardId: Id,
      gates: z.array(GateResult).length(CertificationGate.options.length),
      ready: z.boolean(),
    }),
  ),
});
export type CertificationReadiness = z.infer<typeof CertificationReadiness>;

/** `objectiveProgress`: the latest reading against the target, by direction, and the readings `readingRule` missed. */
export const ObjectiveProgress = z.strictObject({
  objectiveId: Id,
  latestValue: z.number().finite().nullable(),
  latestPeriodEnd: LocalDate.nullable(),
  /** Progress from baseline to target, 0-100; null without a baseline or a reading. */
  progressPercent: z.number().min(0).max(100).nullable(),
  /** Null without a reading. */
  onTrack: z.boolean().nullable(),
  missedReadings: z.array(z.strictObject({ periodStart: LocalDate, periodEnd: LocalDate })),
});
export type ObjectiveProgress = z.infer<typeof ObjectiveProgress>;

/** `auditProgrammeCoverage`: what an FY's reported audits left uncovered, and the "audit programme progress" KPI. */
export const AuditProgrammeCoverage = z.strictObject({
  fy: FyLabel,
  uncoveredClauseIds: z.array(Id),
  uncoveredUnitIds: z.array(Id),
  planned: IdCount,
  reported: IdCount,
  cancelled: IdCount,
});
export type AuditProgrammeCoverage = z.infer<typeof AuditProgrammeCoverage>;

/** `incidentCounts`: by the client-local date of `occurredAt`; the ids are nonconformity ids. */
export const IncidentCounts = z.strictObject({
  from: LocalDate,
  to: LocalDate,
  total: IdCount,
  byType: z.array(z.strictObject({ type: IncidentType, ...IdCount.shape })),
  byOutcome: z.array(z.strictObject({ outcome: IncidentOutcome, ...IdCount.shape })),
});
export type IncidentCounts = z.infer<typeof IncidentCounts>;

/** `climateDeterminationGaps` (model §5.1). */
export const ClimateGap = z.enum(['UNDECIDED', 'RELEVANT_NO_RISK', 'RELEVANT_NO_ISSUE']);
export type ClimateGap = z.infer<typeof ClimateGap>;

export const CertificationCycleKind = z.enum([
  'SURVEILLANCE_1',
  'SURVEILLANCE_2',
  'RECERTIFICATION',
]);
export type CertificationCycleKind = z.infer<typeof CertificationCycleKind>;

/**
 * One due date of a certificate's cycle: met by an external audit of that type (late by `daysLate` when it ended
 * after the due date), or open and overdue by `overdueDays` up to as-of.
 */
export const CertificationCycleItem = z
  .strictObject({
    kind: CertificationCycleKind,
    dueOn: LocalDate,
    metByAuditId: Id.nullable(),
    metOn: LocalDate.nullable(),
    daysLate: z.int().min(1).nullable(),
    overdueDays: z.int().min(1).nullable(),
  })
  .superRefine((c, ctx) => {
    const met = c.metByAuditId !== null;
    if (met !== (c.metOn !== null)) {
      ctx.addIssue({ code: 'custom', path: ['metOn'], message: 'metOn is set exactly when met' });
    }
    if (met && c.overdueDays !== null) {
      ctx.addIssue({ code: 'custom', path: ['overdueDays'], message: 'A met date is not overdue' });
    }
    if (!met && c.daysLate !== null) {
      ctx.addIssue({ code: 'custom', path: ['daysLate'], message: 'Only a met date is late' });
    }
  });
export type CertificationCycleItem = z.infer<typeof CertificationCycleItem>;

/** `certificationCycle`: empty before the certificate is issued. */
export const CertificationCycle = z.strictObject({
  certificationId: Id,
  items: z.array(CertificationCycleItem).max(3),
});
export type CertificationCycle = z.infer<typeof CertificationCycle>;

/** `managementReviewDue`: per standard of the system, the next review due date. */
export const ManagementReviewDue = z.strictObject({
  items: z.array(
    z
      .strictObject({
        standard: IsoStandardCode,
        lastHeldOn: LocalDate.nullable(),
        nextDueOn: LocalDate,
        timing: IsoTiming.exclude(['CLOSED']),
        overdueDays: z.int().min(1).nullable(),
      })
      .refine((s) => (s.timing === 'OVERDUE') === (s.overdueDays !== null), {
        path: ['overdueDays'],
        message: 'overdueDays is set exactly when OVERDUE',
      }),
  ),
});
export type ManagementReviewDue = z.infer<typeof ManagementReviewDue>;

/** One figure of a review input: a camelCase key, its value and the ids behind it (empty for a score). */
export const ReviewFigure = z.strictObject({
  key: z.string().regex(/^[a-z][a-zA-Z0-9]*$/, 'Expected a camelCase key'),
  value: z.number().finite(),
  ids: z.array(Id),
});
export type ReviewFigure = z.infer<typeof ReviewFigure>;

/**
 * `reviewInputFigures`: one input source's figures between `since` and `asOf` (`since` never after `asOf`), the
 * records as they stood on `asOf`; none for MANUAL.
 */
export const ReviewInputFigures = z
  .strictObject({
    source: ReviewInputSource,
    since: LocalDate,
    asOf: LocalDate,
    figures: z.array(ReviewFigure),
  })
  .refine((f) => f.since <= f.asOf, { message: 'since is after asOf', path: ['since'] });
export type ReviewInputFigures = z.infer<typeof ReviewInputFigures>;
