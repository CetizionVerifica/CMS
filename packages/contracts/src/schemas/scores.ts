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

export const ScoreResult = z.strictObject({
  engineVersion: Text,
  asOf: LocalDate,
  /** Percentage with one decimal; null = "No items due". */
  score: Percent.nullable(),
  /** On-time complied / due, unweighted, as a percentage with one decimal; null when nothing is due. */
  onTimeRate: Percent.nullable(),
  counts: z.record(DerivedStatus, z.int().min(0)),
  /** The instances behind each count, so every number links to exactly those rows. */
  instanceIds: z.record(DerivedStatus, z.array(Id)),
});
export type ScoreResult = z.infer<typeof ScoreResult>;

export const Breakdown = z.strictObject({
  by: BreakdownBy,
  rows: z.array(z.strictObject({ key: Text, label: Name, result: ScoreResult })),
});
export type Breakdown = z.infer<typeof Breakdown>;

export const PortfolioRow = z.strictObject({
  clientId: Id,
  clientName: Name,
  result: ScoreResult,
  dueThisWeek: z.int().min(0),
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
