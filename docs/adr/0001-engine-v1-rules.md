# 0001. Compliance engine v1 rules (ENGINE_VERSION 1.0.0)

- Status: accepted
- Date: 2026-10-11
- Module: M4 (`packages/engine`)

## Context
`packages/engine/CLAUDE.md` and contracts v1 (`docs/contracts/domain-model.md` §4, §7) fix the shapes and the main
formulas but leave some semantics open: what a recurrence rule's `anchor` means, which periods a range returns, how
rules are inferred from a register, and which instances get reminders. These choices change dates and numbers users
see, so they are recorded here. Changing any of them bumps `ENGINE_VERSION`.

## Decisions

### Periods and ranges
1. Periods align to the financial year (`fyStartMonth`, default April): months; quarters and halves counted from the FY
   start (Apr-Jun, …; Apr-Sep, Oct-Mar); the FY itself for ANNUAL and yearly reviews.
2. `generateInstances(rule, range)` returns the periods whose **due date** (after holiday adjustment) falls in the range,
   inclusive. FY 2022-23 therefore holds the March 2022 TDS deposit due 7 April 2022, as the sample register does.
3. `periodStart` is unique per rule, so `(assignmentId, periodStart)` stays an idempotent key across re-runs and across
   overlapping ranges.

### Rule semantics
| Kind | Period | Due date |
|---|---|---|
| `ONE_TIME` | the due date itself | `dueDate` |
| `MONTHLY {day, offsetMonths}` | calendar month | `day` (or `LAST`) of the month `offsetMonths` after the period, clamped to the month's length |
| `QUARTERLY` / `HALF_YEARLY {anchor, days}` | FY quarter / half | `PERIOD_END`: `days` before the period end (0 = last day). `AFTER_PERIOD_END`: `days` after it |
| `ANNUAL {month, day}` | the FY | that month/day inside the FY; 29 Feb becomes 28 Feb in common years |
| `FIXED_DATES {dates}` | from the day after the previous fixed date to this one | each date, every FY |
| `ONGOING_REVIEW {every}` | month, quarter, half or FY | the period end |
| `EVENT_DRIVEN {withinDays}` | the event date | event date + `withinDays`; created by `eventInstance` when the event is recorded, never by the calendar |

### Holidays
`NEXT_WORKING_DAY` and `PREVIOUS_WORKING_DAY` move a due date off Sundays and off any dates in the optional
`holidays` list passed with the calendar. Saturdays are working days. The contract calendar has no holiday list yet;
`holidays` is an engine-side optional extension until one exists. `NONE` (the default) never moves a date.

### Rule inference (`inferRule`)
1. Each candidate rule is generated over the window the register covers and compared with the dates as a multiset.
   The window is `options.coverage` when the importer passes it (the span the register was exported for), else the
   first to the last due date, so a client onboarded mid-year is not penalised for months the register never held.
   `confidence = matched / max(expected, generated)`; an unmatched expected date is paired with the nearest unused
   generated date, or `null` when none is left (duplicates).
2. The best periodic rule wins: highest confidence, then the fewest periods a year, then the preference order.
   ONGOING obligations try `ONGOING_REVIEW` first; TIME_BASED ones try ANNUAL, QUARTERLY, HALF_YEARLY, MONTHLY, then
   ONGOING_REVIEW. Quarter and half offsets are tried up to 31 days before the period end and 60 days after it.
3. If periodic rules of different frequencies all match every date (the window is too short to tell, e.g. one date
   with no coverage), the result is ambiguous: the sparsest rule is returned at confidence 0.5 so import flags it
   `TO_REVIEW`.
4. Onboarding gap: if no periodic rule matches the whole window but one matches every date between the first and the
   last, with the dates it adds only before the first or after the last, the register most likely starts or stops
   mid-way (a client onboarded in December). That periodic rule is returned at its window confidence, which is below 1,
   so import flags it `TO_REVIEW` instead of publishing a FIXED_DATES list that drops the missing periods for good.
   A missing date between the first and the last (30 Sep absent between 30 Jun and 31 Dec) is real evidence, so the
   sample's FIXED_DATES rules are unchanged.
5. Without coverage, fewer than three dates never give a confidence above 0.5.
6. FIXED_DATES is tried only when no periodic rule matches every date, for two to four distinct month/days, and wins
   when it is at least as good. From a window shorter than a year its confidence is halved, because the register
   says nothing about the rest of the year. Drifting monthly dates therefore come back as MONTHLY with mismatches.
7. A numeric monthly day prefers `offsetMonths: 1` (statutory deposits are for the previous month); `LAST` prefers 0.
8. On the sample register (coverage FY 2022-23) 111 of 119 obligations regenerate exactly; the other 8 (drifting
   monthly dates and the two duplicate periods) are listed with their mismatches in
   `packages/engine/test/golden.test.ts`.

### Time zones
Due dates are calendar dates; "today" for a client is `localDateIn(now, client.settings.timeZone)`, where the caller
passes `now` as a UTC instant. Modules convert timestamps with this helper before comparing them with due dates or
passing `asOf` to the engine.

### Status, score and reminders
1. `deriveStatus` follows `packages/engine/CLAUDE.md`; `asOf == dueDate` is DUE_SOON, not overdue. APPROVED without
   `completedOn` is invalid input and throws.
2. `computeScore` counts every item passed in; the score and on-time rate use items with `dueDate <= asOf`, excluding
   NOT_APPLICABLE. A SUBMITTED NA request still counts as due until it is approved. Percentages round half up to one
   decimal. A zero weighted denominator gives a `null` score. On the sample this gives fixtures.md §4 exactly.
3. Status is derived from the instance as stored now, not as it stood on `asOf`: an item approved in January shows
   COMPLIED at `asOf` 30 September of the year before. fixtures.md §4 expects this (209 COMPLIED at every `asOf`).
   Point-in-time history would need the audit trail and is a contract decision for M0, not an engine change.
4. `planNotifications` reminds the owner only while the instance is OPEN or SENT_BACK, and escalates to the approver
   while it is OPEN, SENT_BACK or SUBMITTED. APPROVED and NOT_APPLICABLE never notify. It needs the instance `id`
   (requested from M0 as an additive contract change).

## Consequences
Import flags rules below confidence 1 as `TO_REVIEW`. Consultants can override any inferred rule. Period attribution
for annual filings due after the FY they cover (e.g. a return for FY N due in FY N+1) follows the FY the due date falls
in; a contract change would be needed to express the other attribution.
