# 0003. M9 jobs and notifications: schedule, dedupe and what is generated

Status: accepted (M9 PR 1, 2026-10-12)

## Context
M9 runs instance generation, reminders, escalations and the weekly consultant digest (MODULES.md M9,
apps/api/CLAUDE.md § Jobs). It must be idempotent, serve each client in its own time zone (default Asia/Kolkata), never
remind for complied or not-applicable items, and reach the database only through M3's repositories under RLS.

## Decisions
1. **pg-boss 12** runs the jobs in the same Postgres (schema `pgboss`). No new infrastructure. Each job has a `stately`
   queue (at most one queued and one active run), 3 retries with backoff, and a 30-minute expiry.
2. **Schedule.** `generate-instances` runs at 01:00 Asia/Kolkata and catches up once after downtime (`missed: once`).
   `reminders` and `consultant-digest` run every 15 minutes in UTC; each run checks, per client, whether the client's
   local send time (`reminders.sendAtLocalTime`, default 07:00) has passed today. A day the jobs did not run at all is
   skipped, never sent late.
3. **"Today" is the client's date**, from the engine's `localDateIn(now, timeZone)`. Jobs read the clock through an
   injected `Clock` only.
4. **Ports, not tables.** Jobs call a narrow `JobStore`/`FirmTx` interface (apps/api/src/jobs/ports.ts). The Postgres
   adapter maps it onto M3's typed repositories inside `withTenant(systemContext(firmId, requestId))`, one firm at a
   time; the only cross-tenant read is the list of firm ids. Tests use an in-memory store with the same rules.
5. **Generation** covers the current and next FY of each client, narrowed to the assignment's active window, by due
   date (as the engine selects ranges). It skips assignments that are not `APPLICABLE`, `EVENT_DRIVEN` rules (M7
   creates those when the event is recorded) and rules still `TO_REVIEW` (an unconfirmed import guess must not create
   next year's work). Rows insert with `ON CONFLICT (assignment_id, period_start) DO NOTHING`; a generated period whose
   due date already has an instance on that assignment is skipped too, so an imported row with a different period start
   is not twinned. Each created instance gets an `AuditEvent` (SYSTEM, CREATE) and each assignment one
   `instance.generated` event, in the client's transaction. Engine results are memoised per (rule, range, calendar).
6. **Reminders and escalations** come from `engine.planNotifications` only; the candidate query is a prefilter
   (OPEN, SENT_BACK, SUBMITTED; applicable assignment; due date inside the offset window).
7. **Dedupe and delivery.** The send log (`notification_send`, unique per instance, kind and date; digests per
   recipient, kind and date) is claimed first, the email is sent outside any transaction, then the row is marked sent
   with a `notification.sent` event. A crash between send and mark leaves the row pending and the next run sends
   again (at least once); a sent or failed row is never sent again. The dedupe key is instance, kind, send date and
   recipient (contracts `NOTIFICATION_DEDUPE_KEY`), so an owner reassigned after that day's reminder still gets one.
   `notification.sent` uses the send-log row as its aggregate (version 1, one event per row). A transport error leaves the row pending and fails
   the run so pg-boss retries. A recipient with no email or no live membership is recorded as failed (`NO_EMAIL`,
   `NOT_ACTIVE`) without sending.
8. **Digest.** One per consultant per India-time date (the send-log key allows no more, so all clients must agree on
   the date even across time zones). It covers every client of theirs whose digest weekday is that date, and goes out
   once India time passes the earliest send time among those clients. Each client is scored at its own local date with
   `computeScore` and `summarizeKpis` over its current FY. A firm-level digest time zone can replace the India default
   when firms outside India arrive.
9. **Emails** are rendered by `@canopy/notifications`: table layout with inline styles in the design tokens, sentence
   case, status wording from the UI spec, a plain-text part, every interpolated value HTML-escaped, http(s) links only,
   and the client-facing product name. They carry names of the recipient, client, unit and obligation only; never
   evidence, comments or reasons. Logs carry counts and request ids only.
10. **Mail transport** is a `Mailer` port. The SMTP or provider adapter lands with the hosting choice (M1 deviations:
    none chosen yet); until then no dependency is added for it.

## Consequences
- M3 PR 2 must provide, as repository calls: list firm ids (system), clients, generation targets, instance keys,
  idempotent instance insert, audit and outbox writes, reminder candidates, recipients and consultants with membership
  state, score items, and send-log claim, mark sent (setting the event aggregate), mark failed, list done per client and
  list done digests per date.
- `instance.generated` names the assignment as its aggregate with the assignment's current version; a later run for a
  new FY repeats that version for a non-mutating event. M0 decides whether that stands. M9 PR 2 wires the adapter and boots the runner.
- Event consumers (notify approver on `instance.submitted`, owner on `instance.sent_back`, regenerate on
  `assignment.*` and `import.committed`) are a later M9 PR on the same ports.
