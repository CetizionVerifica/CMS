import type { DerivedStatus, HolidayPolicy, TimelineType } from './enums.js';
import type { LocalDate } from './primitives.js';
import type { GeneratedPeriod, InferredRule, RecurrenceRule } from './schemas/library.js';
import type { PlannedNotification, ScoreInput, ScoreResult } from './schemas/scores.js';
import type { FirmSettings, ReminderSettings } from './schemas/tenancy.js';
import type { InstanceStatusInput } from './schemas/work.js';
import type { Id } from './primitives.js';

/**
 * Signatures of the engine functions other modules call (docs/contracts/domain-model.md §4).
 * M4 implements them in packages/engine and can check its exports with `satisfies EngineApi`.
 */

export interface EngineCalendar {
  fyStartMonth: number;
  holidayPolicy: HolidayPolicy;
}

export interface DerivedStatusResult {
  status: DerivedStatus;
  /** Days past the due date when OVERDUE, else null. */
  overdueDays: number | null;
  /** True for a SUBMITTED instance whose due date has passed. */
  submittedOverdue: boolean;
}

export interface EngineApi {
  generateInstances(
    rule: RecurrenceRule,
    range: { from: LocalDate; to: LocalDate },
    cal: EngineCalendar,
  ): GeneratedPeriod[];
  inferRule(dueDates: LocalDate[], timelineType: TimelineType, cal: EngineCalendar): InferredRule;
  deriveStatus(
    i: InstanceStatusInput,
    asOf: LocalDate,
    s: { dueSoonDays: number },
  ): DerivedStatusResult;
  computeScore(items: ScoreInput[], asOf: LocalDate, s: FirmSettings): ScoreResult;
  planNotifications(
    i: InstanceStatusInput & { ownerId: Id; approverId: Id },
    s: ReminderSettings,
    asOf: LocalDate,
  ): PlannedNotification[];
  ENGINE_VERSION: string;
}
