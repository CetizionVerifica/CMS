# M9-0001. Jobs and notifications: schedule, dedupe and what is generated

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
   is not twinned. Each created instance gets an `AuditEvent` (SYSTEM, CREATE) and an `instance.generated`
   event (aggregate: the instance, version 1; contracts 1.2.0), in the client's transaction. Engine results are memoised per (rule, range, calendar).
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

11. **Outbox relay** (`relay-outbox`, every minute, M9 owns it). Per firm, in one transaction: claim up to 200
    unpublished events (`FOR UPDATE SKIP LOCKED`), send each consumed type to the pg-boss queue named after the type
    with the event id as the job id, and mark the batch published. Types without a consumer are marked published
    unsent. A failed send is counted on the row and left for the next run. A crash after sending re-sends the same
    job id, so pg-boss holds one job; consumers are still idempotent on the event id (events.md §1).
12. **Regeneration consumers.** `assignment.created`, `assignment.changed`, `assignment.applicability_changed`,
    `import.committed` (their assignments, in the event's client) and `obligation.pushed` (that obligation's
    assignments in the pushed clients) run the nightly generation for just those assignments, at once. Generation
    only adds missing periods; it never moves or removes an instance, so a shortened `activeTo` leaves later
    instances to the module that changed the assignment.
13. **Event-driven emails.** `instance.submitted` emails the instance's current approver (`APPROVAL_REQUESTED`) and
    `instance.sent_back` its owner (`SENT_BACK`), as soon as the relay delivers the event.
    - **Dedupe key:** the send log's unique index on `notification_send (firm_id, event_id, recipient_id)
      WHERE event_id IS NOT NULL` (M3 migration 0016). A redelivered event sends nothing twice. A second send-back on
      the same day is a new event, so it still reaches the owner. Scheduled sends keep their own key and leave out
      rows with an event id, so the day's reminder and the event email never block each other.
    - **Stale events send nothing:** the consumer re-reads the instance and sends only if its version is still the
      event's `aggregateVersion` (and it is not archived). An approval that lands before the email goes stops it, and
      so does a resubmit followed by a second send-back, which has its own event and email. A reassignment after the
      event also stops it; the daily reminder or escalation then reaches the new owner or approver.
    - **Send date** is the client's day when the email goes. It is recorded only; it is not part of the key.
    - **Retries:** a transport failure leaves the row pending and fails the pg-boss job, which retries it (`runner.ts`
      `RETRIES`: three times, backing off from a minute). The retry sends the pending row once.

## Consequences
- M3 PR 2 must provide, as repository calls: list firm ids (system), clients, generation targets, instance keys,
  idempotent instance insert, audit and outbox writes, reminder candidates, recipients and consultants with membership
  state, score items, and send-log claim, mark sent (setting the event aggregate), mark failed, list done per client and
  list done digests per date.
- M9 PR 2 wires the adapter (`apps/api/src/jobs/postgres-store.ts`, one repository call per port; audit rows take
  their time from the database, in the same transaction as the change). The runner is not booted in a process yet:
  with no mail transport it would record sends as done that never left. It starts in the PR that adds the transport.
- Event consumers (notify approver on `instance.submitted`, owner on `instance.sent_back`, regenerate on
  `assignment.*` and `import.committed`) are a later M9 PR on the same ports.
