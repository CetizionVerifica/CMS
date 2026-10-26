# M16-0003: A held management review stores its input figures

Status: accepted, 2026-10-25; decision 3 limited for incidents on 2026-10-26 (plan v2.5.1). Amends
[M16-0002](M16-0002-iso-plan-v2.md). Plan: `docs/iso/plan.md` v2.5 and v2.5.1; model §1.7, §3.11, §3.13, §4.5, §5.4, §8,
§9 and §10.

## Context

A management review's input rows show figures from the app's records: actions of earlier reviews, context changes,
risks, objectives, nonconformities, incidents, audit results and the evaluation of compliance (model §5.4). Up to
contracts 1.8.1, a held review computed them on every read, "as the records stood on `heldOn`". The M0 mock rebuilt
each record's fields from the audit trail to get there.

The ISO-1a audit (#271, Medium 1) found that the contract could not carry that rebuild. `data` was untyped, it had no
audit events, and it had no time zone to place an event on a local day. Model §5.4 did not mention the rebuild at
all. Making it work would need four things:
- a permanent rule that every ISO write route (83 of the 119 ISO routes) writes a complete before and after for every
  field the figures read;
- a new read of each record's whole history on every review view, pack and archive;
- whole incident objects kept in the audit trail for ever;
- a rewrite of ISO-3's `iso-review.ts`.

Even with all four, held figures would still drift. The evaluation of compliance reads instance workflow as it is
now, an engine version bump re-derives every past review, and a backfill or system job changes history. The mock's
figures also differed by reader, because unit scope ran inside every figure, so a chair limited to one plant
presented partial numbers.

What a certification auditor checks is the retained record of what the review considered (ISO 9001 9.3.3 and
7.5.3). Figures that recompute on every read are not a protected record, whatever they are rebuilt from.

## Decisions

1. **Store once, at RECORD_HELD.** M16 computes each non-`MANUAL` input's figures inside the RECORD_HELD transaction,
   with `asOf = heldOn`. It stores them on the input row with the time and `ENGINE_VERSION`
   (`review_input.source_figures`, `figures_stored_at`, `figures_engine_version`; ISO-2g). A trigger then refuses any
   change to them, or to the row's review, definition or archive. A HELD or CLOSED review returns the stored copy and
   never computes. A PLANNED review computes live as of today. A CANCELLED review, and every `MANUAL` row, has none.
2. **Live data with date rules, no history.** `reviewInputFigures` reads records as they are now. It applies only the
   date rules of model §5.4: creation, archive, closed and settled days, the climate decision's day, readings created by
   `asOf`, three lists of event days for re-rated, changed and not-effective counts, and, for a date a user enters in
   the past, the later of that date and the day of the step that set it, so a backdated record lands in the next review.
   ISO-3 is written this way already, and ISO-3b adds the date rules. Contracts 1.8.2 (ISO-1a2) types `data` per source,
   with no `held` flag and no general list of changes; ISO-1a3 adds the step days.
3. **The whole system, ids cut per reader.** The figures count the review's whole system with no unit scope, so every
   reader sees the same values. Each figure's ids are cut to the records the reader may read (plan §3.3 exception; M3's
   `isoVisibleIds`). The values are counts and sums with no names. They include other units' records, which a reader
   limited to some units sees for the review as a whole. M3 gathers the data once for M16 and M10 (ISO-2h). Incidents
   are the limit (plan v2.5.1, after the #291 audit): an outcome and its lost days can point to a person, so an approver
   or owner whose units do not cover the system's, and who neither chairs nor attends the review, gets the INCIDENTS row
   withheld, on screen and in the pack (model §3.11, §3.13 item 4).
4. **A record, not a cache.** Model §1.7 and `packages/db/CLAUDE.md` rule 7 get this exception. The RECORD_HELD event
   carries the values and the engine version, without ids (model §8). The pack and the client archive print the
   stored copy with its window, recording time and engine version (model §9).

## Consequences

- **Figures are read as they are on the day the review is recorded.** A review recorded days after the meeting counts up
  to `heldOn`, but reads cancellation, significance, severity, outcome, finding type and instance workflow as they were
  when it was recorded. The date rules narrow this gap, `figuresStoredAt` shows it, and recording on the day of the
  meeting closes it. The RECORD_HELD form warns when `heldOn` is before today.
- **A wrong stored figure stays wrong.** Fixing one needs a "retake figures, with a reason" step for client admins,
  which is Later. Until then the event shows what was stored and which engine produced it, and a correction is written
  in the row's notes while the review is HELD, or in the next review's notes once it is CLOSED (model §3.13 item 6).
- **The rebuild code goes.** The mock loses its rebuild helpers, and M10 reads the stored copy: nothing rebuilds. No ISO
  route's audit events become load-bearing for figures, apart from the event and step days that M3 reads for the window
  counts.
- **A review held before its system was set up in the app stores no figures** (from ISO-1a3): the app held none of its
  records on that day, so stored zeros would misstate what the review considered.
- **Each held review stores roughly 100-250 KB of jsonb,** most of it the statutory instance ids in the evaluation of
  compliance. That is about what a live read returns today.
- **New packages:** ISO-1a2 and ISO-1a3 (M0, contracts 1.8.2 and the patch after ISO-1b), ISO-2g and ISO-2h (M3) and
  ISO-3b (M4). ISO-1c, ISO-6c, ISO-8c and ISO-11d gain brief lines and Needs (plan §6).
