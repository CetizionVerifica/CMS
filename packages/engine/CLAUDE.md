# packages/engine: compliance calculations

Pure TypeScript. No database, network, clock or file access. Root `CLAUDE.md` applies.
Everything else (api, web, importer, jobs) calls this package for recurrence, due dates, status and scores.

## Rules
1. **Pure functions only.** The current date is always a parameter (`asOf: LocalDate`), never `new Date()` inside the engine.
2. **LocalDate for due dates**, an ISO `YYYY-MM-DD` branded type. Use the package's date helpers; do not use JS `Date` arithmetic for calendar maths.
3. **Every function has unit tests with explicit dates**, including month ends, 29 Feb, FY boundaries (31 Mar / 1 Apr) and quarter ends.
4. Changing a formula or rule is a product decision: add an ADR (`docs/adr/M4-NNNN-slug.md`) and bump `ENGINE_VERSION`. Stored scores record the engine version that produced them.

## Recurrence rules
`RecurrenceRule` is a discriminated union:
- `ONE_TIME { dueDate }`
- `MONTHLY { day | "LAST", offsetMonths }` e.g. TDS/TCS deposit: day 7 of the following month (`offsetMonths: 1`)
- `QUARTERLY { anchor: "PERIOD_END" | "AFTER_PERIOD_END", days }` e.g. "within 15 days from the closure of each quarter"
- `HALF_YEARLY { anchor, days }` (same shape as QUARTERLY), `ANNUAL { month, day }` e.g. Unified Annual Return on 1 Feb
- `FIXED_DATES { dates: MonthDay[] }` e.g. employment exchange return by 30 Apr, 30 Jul, 30 Oct, 30 Jan
- `ONGOING_REVIEW { every: "MONTH" | "QUARTER" | "HALF_YEAR" | "YEAR" }` for "On Going" obligations (the sample uses quarterly review due at quarter end)
- `EVENT_DRIVEN { trigger, withinDays }` instance created when the event is recorded (e.g. accident, new contractor)

`generateInstances(rule, period: {from, to}, calendar)` returns `{ periodStart, periodEnd, dueDate }[]`.
Calendar options: FY start month (default April), and `holidayPolicy` `NONE | NEXT_WORKING_DAY | PREVIOUS_WORKING_DAY` (default NONE; statutory dates usually do not move).
Generation is idempotent: the key is `(assignmentId, periodStart)`; re-running never duplicates.

Golden test: for each sample obligation, the inferred rule must regenerate the same FY 2022-23 due dates the Excel holds.

## Status derivation
Stored workflow state: `OPEN | SUBMITTED | SENT_BACK | APPROVED | NOT_APPLICABLE`.
Displayed status is derived by `deriveStatus(instance, asOf, settings)`, which returns `{ status, overdueDays, submittedOverdue }`:
- `APPROVED` and `completedOn <= dueDate` → COMPLIED; `completedOn > dueDate` → COMPLIED_LATE
- `NOT_APPLICABLE` → NOT_APPLICABLE
- `SUBMITTED` → SUBMITTED (also flag overdue if `asOf > dueDate`)
- `SENT_BACK` or `OPEN`: `asOf > dueDate` → OVERDUE (days = asOf - dueDate); `dueDate - asOf <= dueSoonDays` (default 7) → DUE_SOON; else UPCOMING
Excel mapping: Complied → APPROVED, Pending → OPEN, Not Applicable → NOT_APPLICABLE.

## Scores and KPIs
Inputs are instances with `dueDate <= asOf` in the selected period, excluding NOT_APPLICABLE.
- Criticality weights (default, configurable per firm): Super Critical 5, Critical 4, High 3, Medium 2, Low 1.
- **Compliance score** (`computeScore`) = Σ weight(complied on time) + 0.5 × Σ weight(complied late), divided by Σ weight(all due), as a percentage rounded to one decimal. Empty denominator → `null` (show "No items due"), never 0 or 100.
- **On-time rate** = on-time complied / due (unweighted).
- **Open, overdue, due this week, awaiting approval** = counts by derived status.
- Breakdowns by department, Act, criticality, unit and owner use the same functions so dashboard numbers always equal register filters.
Return numbers plus the instance ids behind them, so the UI can link "5 overdue" to exactly those rows.

## Reminders and escalation
`planNotifications(instance, settings, asOf)` returns what is due to send today. Defaults: owner at T-7, T-3 and T-0; approver at +1 and +7 days overdue;
consultant digest weekly. Never return a notification for COMPLIED or NOT_APPLICABLE. The job runner dedupes by `(instanceId, kind, sendDate)`.

## v1 decisions (docs/adr/0001-engine-v1-rules.md)
- Ranges select periods by due date. Quarters and halves follow the FY start month.
- `PERIOD_END` counts `days` back from the period end; `AFTER_PERIOD_END` counts forward.
- Holiday policies skip Sundays and an optional `holidays` list on the calendar.
- The sample-register golden fixture is `test/fixtures/sample-fy2022-23.json` (no names), produced by
  `test/fixtures/extract-sample.py`; low-confidence obligations are listed in `test/golden.test.ts`.
- `inferRule` scores over the window the register covers (`options.coverage`); importers should pass it.
- "Today" for a client is `localDateIn(now, timeZone)`; never compare a timestamp with a due date directly.
- `clientPeriods({ today, fyStartMonth, generatedFrom, generatedTo })` feeds the period picker (contracts `ClientPeriods`):
  current FY and quarter, the current FY plus every FY from the first to the last generated date (generation is
  contiguous), and the last generated month. FY labels follow `fyLabel` (start year, then the next year's two digits)
  for every start month.

## ISO add-on (docs/adr/M4-0001-iso-engine-rules.md)
ISO functions live in `src/iso-score.ts`, `src/iso-status.ts` (100% coverage by name), `src/iso-notifications.ts` and
`src/iso-review.ts`, exported as `isoEngine` (`satisfies IsoEngineApi`). The state machines of `docs/iso/model.md` §4
are data (`ISO_TRANSITIONS`); `isoTransition` reads only the facts the caller passes, and a missing fact never
satisfies a guard. Timing uses the instance rule: overdue the day after, due soon within `dueSoonDays`.
