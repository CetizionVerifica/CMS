import type {
  Id,
  InstanceStatusInput,
  LocalDate,
  PlannedNotification,
  ReminderSettings,
} from '@canopy/contracts';
import { daysBetween, isoWeekday } from './dates.js';

/**
 * Reminders and escalations due on `asOf` (packages/engine/CLAUDE.md "Reminders and escalation").
 * Owners are reminded `ownerDaysBefore` days before the due date while the instance is OPEN or SENT_BACK.
 * Approvers are escalated to `approverDaysAfter` days after it while the instance is OPEN, SENT_BACK or
 * SUBMITTED. APPROVED (complied, on time or late) and NOT_APPLICABLE instances never get a notification.
 * The job runner dedupes by `(instanceId, kind, sendDate)`.
 */
export function planNotifications(
  i: InstanceStatusInput & { id: Id; ownerId: Id; approverId: Id },
  s: ReminderSettings,
  asOf: LocalDate,
): PlannedNotification[] {
  if (i.workflowState === 'APPROVED' || i.workflowState === 'NOT_APPLICABLE') return [];
  const offsetDays = daysBetween(i.dueDate, asOf);
  const planned: PlannedNotification[] = [];
  const ownerTurn = i.workflowState === 'OPEN' || i.workflowState === 'SENT_BACK';
  if (ownerTurn && offsetDays <= 0 && s.ownerDaysBefore.includes(-offsetDays)) {
    planned.push({
      kind: 'OWNER_REMINDER',
      recipientId: i.ownerId,
      instanceId: i.id,
      sendDate: asOf,
      offsetDays,
    });
  }
  if (offsetDays >= 0 && s.approverDaysAfter.includes(offsetDays)) {
    planned.push({
      kind: 'APPROVER_ESCALATION',
      recipientId: i.approverId,
      instanceId: i.id,
      sendDate: asOf,
      offsetDays,
    });
  }
  return planned;
}

/** True on the weekday the consultant digest goes out. */
export function isConsultantDigestDay(asOf: LocalDate, s: ReminderSettings): boolean {
  return isoWeekday(asOf) === s.consultantDigestWeekday;
}
