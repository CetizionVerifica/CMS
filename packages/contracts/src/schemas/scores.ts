import { z } from 'zod';
import {
  BreakdownBy,
  Criticality,
  DerivedStatus,
  ExportKind,
  JobStatus,
  NotificationKind,
  SubmissionKind,
  WorkflowState,
} from '../enums.js';
import { baseShape, Id, Instant, LocalDate, Name, Text } from '../primitives.js';

/** Dashboards, scores, notifications and exports (docs/contracts/domain-model.md §7). */

export const ScoreInput = z.strictObject({
  instanceId: Id,
  criticality: Criticality,
  dueDate: LocalDate,
  workflowState: WorkflowState,
  pendingKind: SubmissionKind.nullable(),
  completedOn: LocalDate.nullable(),
});
export type ScoreInput = z.infer<typeof ScoreInput>;

/** A percentage 0-100, one decimal place. */
const Percent = z
  .number()
  .min(0)
  .max(100)
  .refine((n) => Math.abs(n * 10 - Math.round(n * 10)) < 1e-9, {
    message: 'Expected at most one decimal place',
  });

export const ScoreResult = z
  .strictObject({
    engineVersion: Text,
    asOf: LocalDate,
    /** Percentage with one decimal; null = "No items due". */
    score: Percent.nullable(),
    /** On-time complied / due, unweighted, as a percentage with one decimal; null when nothing is due. */
    onTimeRate: Percent.nullable(),
    counts: z.record(DerivedStatus, z.int().min(0)),
    /** The instances behind each count, so every number links to exactly those rows. */
    instanceIds: z.record(DerivedStatus, z.array(Id)),
  })
  .superRefine((r, ctx) => {
    for (const status of DerivedStatus.options) {
      if (r.counts[status] !== r.instanceIds[status].length) {
        ctx.addIssue({
          code: 'custom',
          path: ['counts', status],
          message: `counts.${status} must equal the number of instanceIds.${status}`,
        });
      }
    }
  });
export type ScoreResult = z.infer<typeof ScoreResult>;

export const Breakdown = z.strictObject({
  by: BreakdownBy,
  rows: z.array(z.strictObject({ key: Text, label: Name, result: ScoreResult })),
});
export type Breakdown = z.infer<typeof Breakdown>;

/**
 * The register filter behind a portfolio row's "due this week" count: open work (OPEN, SENT_BACK) due from `asOf`
 * through six days later. Its fields are register query parameters (`GET /clients/{clientId}/instances`), so the web
 * app can link to the register filtered to exactly those items.
 */
export const DueThisWeekFilter = z
  .strictObject({
    dueFrom: LocalDate,
    dueTo: LocalDate,
    workflowState: z.array(WorkflowState).min(1),
  })
  .refine((f) => f.dueFrom <= f.dueTo, {
    path: ['dueTo'],
    message: 'dueTo is on or after dueFrom',
  });
export type DueThisWeekFilter = z.infer<typeof DueThisWeekFilter>;

export const PortfolioRow = z.strictObject({
  clientId: Id,
  clientName: Name,
  result: ScoreResult,
  dueThisWeek: z.int().min(0),
  /** The register filter that lists the `dueThisWeek` items. Optional so existing providers stay valid. */
  dueThisWeekFilter: DueThisWeekFilter.optional(),
  lastActivityAt: Instant.nullable(),
});
export type PortfolioRow = z.infer<typeof PortfolioRow>;

export const PlannedNotification = z.strictObject({
  kind: NotificationKind,
  recipientId: Id,
  instanceId: Id,
  sendDate: LocalDate,
  /** Days relative to the due date: negative before, positive after. */
  offsetDays: z.int(),
});
export type PlannedNotification = z.infer<typeof PlannedNotification>;

/**
 * A scheduled notification is sent at most once per these fields (events.md §4 rule 4). `recipientId` is part of the
 * key, so a person who becomes owner or approver on the day another was reminded is still reminded.
 */
export const NOTIFICATION_DEDUPE_KEY = [
  'instanceId',
  'kind',
  'sendDate',
  'recipientId',
] as const satisfies readonly (keyof PlannedNotification)[];

/** Kinds sent in reaction to a domain event rather than on a schedule. */
export const EVENT_NOTIFICATION_KINDS = [
  'APPROVAL_REQUESTED',
  'SENT_BACK',
] as const satisfies readonly NotificationKind[];

/**
 * Scheduled kinds about the whole account rather than a client or an instance, so their send-log row has neither:
 * the trial-ending email to the account admins (ADR M15-0001, order of work step 6). They dedupe on recipient, kind and send
 * date, as digests do (events.md §4 rule 4).
 */
export const ACCOUNT_NOTIFICATION_KINDS = [
  'TRIAL_ENDING',
] as const satisfies readonly NotificationKind[];

/**
 * An event-driven notification is sent at most once per source event and recipient (events.md §4 rule 4), so a
 * redelivered event sends nothing new, while a second submission (a new event) notifies again.
 */
export const EVENT_NOTIFICATION_DEDUPE_KEY = ['sourceEventId', 'recipientId'] as const;

export const ExportJob = z.strictObject({
  ...baseShape,
  clientId: Id,
  kind: ExportKind,
  params: z.record(z.string(), z.unknown()),
  status: JobStatus,
  fileName: Text.max(255).nullable(),
  requestedById: Id,
});
export type ExportJob = z.infer<typeof ExportJob>;
