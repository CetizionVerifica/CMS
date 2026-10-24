'use client';
// The client's reminder settings: when owners hear about a due date, when approvers hear about a waiting
// submission, the send time and the consultants' digest day. The settings are read back in sentences before saving.
import type { ReminderSettings } from '@canopy/contracts';
import { Button, Input, Select } from '@canopy/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { saveRemindersAction } from '../actions';
import { daysText, parseDays, reminderSummary, WEEKDAYS } from '../setup-model';

const DAYS_ERROR = 'Use whole numbers from 0 to 90, separated by commas (at most 10).';
const WEEKDAY_OPTIONS = WEEKDAYS.map((label, i) => ({ value: String(i + 1), label }));

export function RemindersForm({
  clientId,
  version,
  reminders,
}: {
  clientId: string;
  version: number;
  reminders: ReminderSettings;
}) {
  const router = useRouter();
  const [before, setBefore] = useState(daysText(reminders.ownerDaysBefore));
  const [after, setAfter] = useState(daysText(reminders.approverDaysAfter));
  const [time, setTime] = useState(reminders.sendAtLocalTime);
  const [weekday, setWeekday] = useState(String(reminders.consultantDigestWeekday));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // Only a new version from the server (after a save, or someone else's) replaces the form; a refresh after a
  // refused save keeps what was typed.
  const latest = useRef(reminders);
  latest.current = reminders;
  useEffect(() => {
    const r = latest.current;
    setBefore(daysText(r.ownerDaysBefore));
    setAfter(daysText(r.approverDaysAfter));
    setTime(r.sendAtLocalTime);
    setWeekday(String(r.consultantDigestWeekday));
  }, [version]);

  const ownerDays = parseDays(before);
  const approverDays = parseDays(after);
  const timeOk = /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  const next: ReminderSettings | null =
    ownerDays && approverDays && timeOk
      ? {
          ownerDaysBefore: ownerDays,
          approverDaysAfter: approverDays,
          sendAtLocalTime: time,
          consultantDigestWeekday: Number(weekday),
        }
      : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!next) return;
    setPending(true);
    setError(null);
    setSaved(null);
    const result = await saveRemindersAction(clientId, { version, reminders: next });
    setPending(false);
    if (!result.ok) setError(result.message);
    else setSaved('Reminder settings saved.');
    router.refresh();
  };

  return (
    <form className="flex max-w-2xl flex-col gap-4" onSubmit={(e) => void submit(e)}>
      <Input
        label="Remind owners this many days before the due date"
        helper="For example 7, 3, 1. Use 0 for the due date itself."
        value={before}
        inputMode="numeric"
        error={ownerDays ? undefined : DAYS_ERROR}
        onChange={(e) => setBefore(e.target.value)}
      />
      <Input
        label="Remind approvers this many days after a submission reaches them"
        helper="For example 2, 5. Leave it empty for no approver reminders."
        value={after}
        inputMode="numeric"
        error={approverDays ? undefined : DAYS_ERROR}
        onChange={(e) => setAfter(e.target.value)}
      />
      <Input
        label="Send reminders at"
        helper="In the client's time zone."
        type="time"
        value={time}
        error={timeOk ? undefined : 'Choose a time.'}
        onChange={(e) => setTime(e.target.value)}
        className="max-w-48"
      />
      <Select
        label="Consultants' weekly digest"
        options={WEEKDAY_OPTIONS}
        value={weekday}
        onValueChange={setWeekday}
        className="max-w-64"
      />
      {next ? (
        <section
          aria-labelledby="summary-heading"
          className="rounded-card border border-line bg-surface p-4"
        >
          <h2 id="summary-heading" className="mb-2 text-body font-semibold text-ink">
            With these settings
          </h2>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-body text-ink">
            {reminderSummary(next).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {error ? (
        <p role="alert" className="text-body text-crit-ink">
          {error}
        </p>
      ) : null}
      <div>
        <Button
          type="submit"
          loading={pending}
          disabledReason={next ? undefined : 'Fix the highlighted fields first'}
        >
          Save reminders
        </Button>
      </div>
      <p role="status" className="text-body text-ok-ink">
        {saved}
      </p>
    </form>
  );
}
