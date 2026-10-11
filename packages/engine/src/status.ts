import type { DerivedStatusResult, InstanceStatusInput, LocalDate } from '@canopy/contracts';
import { compareDates, daysBetween } from './dates.js';

/**
 * Displayed status from the stored workflow state (packages/engine/CLAUDE.md "Status derivation").
 * Never stored as truth; every screen, report and score derives it here with the same `asOf`.
 */
export function deriveStatus(
  i: InstanceStatusInput,
  asOf: LocalDate,
  s: { dueSoonDays: number },
): DerivedStatusResult {
  const pastDue = compareDates(asOf, i.dueDate) > 0;
  switch (i.workflowState) {
    case 'APPROVED': {
      if (i.completedOn === null) {
        throw new RangeError('An APPROVED instance needs completedOn');
      }
      const late = compareDates(i.completedOn, i.dueDate) > 0;
      return {
        status: late ? 'COMPLIED_LATE' : 'COMPLIED',
        overdueDays: null,
        submittedOverdue: false,
      };
    }
    case 'NOT_APPLICABLE':
      return { status: 'NOT_APPLICABLE', overdueDays: null, submittedOverdue: false };
    case 'SUBMITTED':
      return { status: 'SUBMITTED', overdueDays: null, submittedOverdue: pastDue };
    case 'OPEN':
    case 'SENT_BACK': {
      if (pastDue) {
        return {
          status: 'OVERDUE',
          overdueDays: daysBetween(i.dueDate, asOf),
          submittedOverdue: false,
        };
      }
      const dueSoon = daysBetween(asOf, i.dueDate) <= s.dueSoonDays;
      return {
        status: dueSoon ? 'DUE_SOON' : 'UPCOMING',
        overdueDays: null,
        submittedOverdue: false,
      };
    }
  }
}
