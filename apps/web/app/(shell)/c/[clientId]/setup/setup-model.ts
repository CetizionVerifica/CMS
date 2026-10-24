// Plain helpers behind the setup screens (MODULES.md M13): parsing what people type into the shapes the API takes,
// and the words the screens show. No compliance logic here (root rule 3); reminders are settings, not due-date maths.
import type { Department, ReminderSettings } from '@canopy/contracts';

/** "HR, Human resources\nPeople" → ["HR", "Human resources", "People"], without blanks, repeats or the name itself. */
export function parseAliases(text: string, name = ''): string[] {
  const seen = new Set([name.trim().toLowerCase()]);
  const out: string[] = [];
  for (const part of text.split(/[,\n]/)) {
    const alias = part.trim().replace(/\s+/g, ' ');
    const key = alias.toLowerCase();
    if (alias === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
  }
  return out;
}

export const aliasText = (aliases: readonly string[]) => aliases.join(', ');

export type DepartmentRow = { id: string; name: string; aliases: string; version: number };

export const departmentRows = (departments: readonly Department[]): DepartmentRow[] =>
  departments.map((d) => ({
    id: d.id,
    name: d.name,
    aliases: aliasText(d.aliases),
    version: d.version,
  }));

/** "1, 3, 7" → [7, 3, 1] for days before, or null when a value is not a whole number from 0 to 90. */
export function parseDays(text: string): number[] | null {
  const parts = text
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  const days = new Set<number>();
  for (const part of parts) {
    if (!/^\d{1,2}$/.test(part)) return null;
    const day = Number(part);
    if (day > 90) return null;
    days.add(day);
  }
  if (days.size > 10) return null;
  return [...days].sort((a, b) => b - a);
}

export const daysText = (days: readonly number[]) => days.join(', ');

export const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

const dayWord = (n: number) => (n === 1 ? '1 day' : `${n} days`);

function list(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** The reminder settings read back as sentences, so the person can check them before saving. */
export function reminderSummary(r: ReminderSettings): string[] {
  const before = [...r.ownerDaysBefore].sort((a, b) => b - a).filter((d) => d > 0);
  const onDue = r.ownerDaysBefore.includes(0);
  const after = [...r.approverDaysAfter].sort((a, b) => a - b);
  const owners =
    before.length === 0 && !onDue
      ? 'Owners get no reminders before a due date.'
      : `Owners are reminded ${[
          ...(before.length > 0 ? [`${list(before.map(dayWord))} before the due date`] : []),
          ...(onDue ? ['on the due date'] : []),
        ].join(', and ')}.`;
  const approvers =
    after.length === 0
      ? 'Approvers get no reminders about submissions.'
      : `Approvers are reminded ${list(after.map((d) => (d === 0 ? 'the same day' : dayWord(d))))} after a submission reaches them.`;
  return [
    owners,
    approvers,
    `Reminders go out at ${r.sendAtLocalTime} in the client's time zone.`,
    `Consultants get a weekly digest every ${WEEKDAYS[r.consultantDigestWeekday - 1]}.`,
  ];
}
