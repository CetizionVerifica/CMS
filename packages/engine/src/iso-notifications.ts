import type {
  IsoNotificationInput,
  IsoReminderSchedule,
  LocalDate,
  PlannedIsoNotification,
} from '@canopy/contracts';
import { daysBetween } from './dates.js';

/**
 * ISO reminders due on `asOf` (docs/iso/model.md §5.3, §7; ADR M4-0001). Each item uses the schedule rule for its kind
 * and subject type: it is sent on each `offsetDays` day from its anchor (negative before it) and, with
 * `repeatEveryDays`, every that many days after the last offset while the item stays open. Closed items (`open:
 * false`) and items without a rule get nothing. One notification per distinct recipient, dated `asOf`, so a daily run
 * plans each once; the job runner dedupes by `ISO_NOTIFICATION_DEDUPE_KEY`. `planNotifications` stays instance-only.
 */
export function planIsoNotifications(
  items: readonly IsoNotificationInput[],
  schedule: IsoReminderSchedule,
  asOf: LocalDate,
): PlannedIsoNotification[] {
  const planned: PlannedIsoNotification[] = [];
  for (const item of items) {
    if (!item.open) continue;
    const rule = schedule.find(
      (r) => r.kind === item.kind && r.isoSubjectType === item.isoSubjectType,
    );
    if (rule === undefined) continue;
    const offsetDays = daysBetween(item.anchorDate, asOf);
    const last = Math.max(...rule.offsetDays);
    const repeats =
      rule.repeatEveryDays !== null &&
      offsetDays > last &&
      (offsetDays - last) % rule.repeatEveryDays === 0;
    if (!rule.offsetDays.includes(offsetDays) && !repeats) continue;
    for (const recipientId of new Set(item.recipientIds)) {
      planned.push({
        kind: item.kind,
        recipientId,
        isoSubjectType: item.isoSubjectType,
        isoSubjectId: item.isoSubjectId,
        sendDate: asOf,
        offsetDays,
      });
    }
  }
  return planned;
}
