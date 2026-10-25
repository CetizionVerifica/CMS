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
10. **Mail transport** is a `Mailer` port with one adapter, generic SMTP (`smtp-mailer.ts`, nodemailer). Any provider
    with an SMTP relay works, so choosing one only means filling in credentials. Settings come from the environment:
    `SMTP_URL`, or `SMTP_HOST` with `SMTP_PORT` (default 587), `SMTP_USER`, `SMTP_PASS` and `SMTP_SECURE`, plus
    `MAIL_FROM` and `APP_URL`.
    - `startJobsFromEnv` boots the runner on the Postgres store. When no SMTP server is set, instance generation,
      the outbox relay and the regeneration consumers still run, and every job and consumer that sends email
      (`sendsMail`) is left unregistered. No send is ever claimed or recorded as done without a transport. Events
      that only an email consumer reads are marked relayed and never emailed later: a submission made while mail was
      off is not announced once it is turned on, and the daily reminders cover it instead. The runner reports `mail:
      false` so the caller can warn. It throws at boot on half-set settings, naming the variables but never their
      values, and closes the transport if the runner then fails to start.
    - The Message-ID is a hash of the send-log key, so a re-sent pending row carries the same id.
    - `Auto-Submitted: auto-generated` marks every email.
    - A failure throws with SMTP codes only, never the address or the content.

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
14. **Sign-in link and invite emails** (`login-emails.ts`). `auth.magic_link_requested` emails a `MAGIC_LINK` to the
    person, and `person.invited` emails an `INVITE` to the address on the invite. Both are keyed like decision 13 (the
    event and the recipient). Their send-log rows have no instance, and a sign-in link or firm-role invite has no
    client either.
    - **Tokens:** the job calls M5's `issueLoginToken` (passed to `startJobsFromEnv`), which stores only the token's
      hash. The raw token goes into the link and nowhere else: not the send log, the `notification.sent` event or
      any log line. It is issued only after the claim and the recipient checks pass, so a failed or skipped send
      creates no token. A transport failure retries with a fresh token. The first one, if it was delivered, still
      works until it expires. Without an issuer the two consumers are left off, like the mail ones without a
      transport (decision 10): their events are marked relayed and nothing is sent.
    - **Stale:** a sign-in link asked for more than 15 minutes earlier is not sent, since the person has asked
      again or given up. An invite that is accepted, revoked, expired or names another person sends nothing.
    - **Who may receive:** sign-in links go only to ACTIVE people (NOT_ACTIVE or NO_EMAIL otherwise). An invite goes
      to its address whatever the person's status, because the invite itself is the consent to email them.
    - **Send date:** the client's day, or Asia/Kolkata's (the product default) when there is no client.
15. **Evidence virus scan** (`scan-evidence.ts`, every minute, stately). Evidence is `PENDING` from upload until the
    scan records `CLEAN`, `INFECTED` or `FAILED`, and only `CLEAN` files can be downloaded (M7). The job reads PENDING,
    non-archived files oldest first, streams each from the evidence bucket to the scanner, and writes the result with
    an `UPDATE` audit row and an `evidence.scanned` event, both on the instance, in one transaction. The audit row
    carries the evidence id and the `before`/`after` scan status, plus the signature when infected, as M7's
    `scanned()` writes it, so scan results show in the instance's history. The event carries ids and the status only.
    - **Scanner port:** `Scanner.scan(stream, signal)`. The default is ClamAV's daemon over TCP
      (`clamav-scanner.ts`, the `INSTREAM` command, no new dependency), set by `CLAMAV_HOST` with `CLAMAV_PORT` (3310)
      and `CLAMAV_TIMEOUT_MS` (180000, at most 240000). The timeout must stay above clamd's `MaxScanTime` (120 s by
      default), so clamd gives its own answer first. clamd's `StreamMaxLength` must be at least 26M, above the 25 MiB
      evidence limit, and it should run with `AlertExceedsMax yes`, or with `MaxFileSize` and `MaxScanSize` above
      25 MiB: otherwise clamd answers `OK` for a file it only scanned in part. A host's own scanning service plugs in
      as `startJobsFromEnv({ scanner })`.
    - **Off without a scanner,** like the mail jobs (decision 10): the runner's `scan` is false, files stay PENDING
      and none is marked clean unscanned. A scanner without the `S3_*` bucket throws at boot.
    - **CLEAN only for the whole file:** the job counts the bytes it streams and records CLEAN only when they equal
      the size the upload recorded. A shorter stream is a failed attempt (`TRUNCATED`). INFECTED stands even from
      part of a file.
    - **Deadlines:** each file gets one 5-minute deadline (an `AbortController` passed to the S3 read and the scan).
      The S3 client also fails a connection that does not open in 10 s or storage that has not started answering in
      60 s (`throwOnRequestTimeout`; without it the SDK only warns). The deadline bounds the transfer itself.
    - **Three kinds of failure** (`ports.ts`):
      - `ScanServiceError`: storage or the scanner cannot be reached, or storage answers 5xx or rejects the
        credentials or bucket. Every file would fail the same way, so the run stops and nothing is counted against the
        file. The next run starts over.
      - `ScanInterruptedError` (storage stops sending a file part-way): the network or that one object, so it is a
        failed attempt (`INTERRUPTED`) and the run stops. One bad object cannot block the queue, and an outage costs
        each file at most one attempt per run.
      - `ScanTimeoutError` (the file's deadline, or clamd not answering in time): a failed attempt on the file, and
        the run stops in case the scanner is stuck.
      - Anything else (storage refuses this one object, an unexpected reply): a failed attempt, and the run moves on.
    - **Attempts:** each failed attempt is an `UPDATE` audit row on the instance (`after: {evidenceId, scanStatus:
      'PENDING', scanAttempt, scanError}`, a code with no error text). The job counts those rows, so attempts survive restarts
      with no new column. On the third the file is FAILED (`after.attempts: 3`), so one file that never scans cannot
      hold up the rest of the firm's. A file that failed in a run is not tried again in the same run.
    - **FAILED** is about the file: nothing is stored at its key, clamd answers `… ERROR` (over its size limit, or a
      scan limit such as an archive bomb), or three attempts failed. The person uploads it again.
    - **Time budget:** a run starts no new file after 10 minutes; with one file's deadline on top it ends inside the
      30-minute job expiry.
    - **Follow-up for M3:** `listPendingEvidence` reads each client's PENDING files through the vault page by page
      and sorts them in memory, which is quadratic for a large backlog. A repository call with `ORDER BY created_at,
      id LIMIT n` would replace it.
    - **Not yet:** telling the uploader about an INFECTED file (`evidence.scanned`'s consumer, events.md).
16. **Job schema and login.** pg-boss keeps its tables in the `pgboss` schema, which M3 migration 0022 creates and a
    later M3 migration hands to the NOLOGIN role `canopy_jobs`. From then on no app login (`canopy_app`, lookup,
    platform, operator) has `USAGE` or `CREATE` on it, so tenant code cannot read or change job rows.
    - **Own login:** pg-boss connects with `JOBS_DATABASE_URL`, a login that is a member of `canopy_jobs` only and
      defaults to it, so the tables and queue partitions it creates belong to `canopy_jobs`. The tenant login must
      never default to `canopy_jobs`. Without `JOBS_DATABASE_URL` the runner uses the API's `DATABASE_URL`. Once
      `canopy_jobs` owns the schema, that works only for a superuser, or a login that is a member of `canopy_jobs`
      (pg-boss's tables are then owned by whichever role it runs as), as in local development. Owning the database
      is not enough. The tenant login, a plain member of `canopy_app`, has no `USAGE` on the schema, so the API
      stops at boot with the "set JOBS_DATABASE_URL" error.
    - **No schema creation:** the runner passes `createSchema: false`, since `CREATE SCHEMA IF NOT EXISTS` needs
      `CREATE` on the database. It refuses to start when the schema is missing ("run the database migrations
      first").
    - **Deploy, once, as an admin:**
      1. `CREATE ROLE canopy_jobs NOLOGIN;` (if the migrations have not), then `GRANT canopy_jobs TO <migrating
         owner>;` so the migrations can hand it the schema.
      2. `CREATE ROLE canopy_jobs_login LOGIN PASSWORD '…' IN ROLE canopy_jobs;` and
         `ALTER ROLE canopy_jobs_login SET role = canopy_jobs;`.
      3. Set `JOBS_DATABASE_URL=postgres://canopy_jobs_login:…@<host>/<db>` for the API.

## Consequences
- M3 PR 2 must provide, as repository calls: list firm ids (system), clients, generation targets, instance keys,
  idempotent instance insert, audit and outbox writes, reminder candidates, recipients and consultants with membership
  state, score items, and send-log claim, mark sent (setting the event aggregate), mark failed, list done per client and
  list done digests per date.
- M9 PR 2 wires the adapter (`apps/api/src/jobs/postgres-store.ts`, one repository call per port; audit rows take
  their time from the database, in the same transaction as the change). The API process boots the jobs through
  `startJobsFromEnv` (wired in `main.ts` by the CI thread); without SMTP settings only the email jobs stay off.
- Event consumers (notify approver on `instance.submitted`, owner on `instance.sent_back`, regenerate on
  `assignment.*` and `import.committed`) are a later M9 PR on the same ports.
