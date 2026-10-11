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
1. Each candidate rule is generated over the FYs the dates span and compared with the dates as a multiset.
   `confidence = matched / max(expected, generated)`; an unmatched expected date is paired with the nearest unused
   generated date, or `null` when none is left (duplicates).
2. Highest confidence wins; ties go to the earlier candidate. ONGOING obligations try `ONGOING_REVIEW` first;
   TIME_BASED ones try ANNUAL, QUARTERLY, HALF_YEARLY, MONTHLY, then ONGOING_REVIEW. FIXED_DATES comes last and only for
   at most four distinct month/days, so drifting monthly dates come back as MONTHLY with mismatches. Quarter and half
   offsets are tried up to 31 days before the period end and 60 days after it.
3. A numeric monthly day prefers `offsetMonths: 1` (statutory deposits are for the previous month); `LAST` prefers 0.
4. On the sample register 111 of 119 obligations regenerate exactly; the other 8 (drifting monthly dates and the two
   duplicate periods) are listed with their mismatches in `packages/engine/test/golden.test.ts`.

### Status, score and reminders
1. `deriveStatus` follows `packages/engine/CLAUDE.md`; `asOf == dueDate` is DUE_SOON, not overdue. APPROVED without
   `completedOn` is invalid input and throws.
2. `computeScore` counts every item passed in; the score and on-time rate use items with `dueDate <= asOf`, excluding
   NOT_APPLICABLE. A SUBMITTED NA request still counts as due until it is approved. Percentages round half up to one
   decimal. A zero weighted denominator gives a `null` score. On the sample this gives fixtures.md §4 exactly.
3. `planNotifications` reminds the owner only while the instance is OPEN or SENT_BACK, and escalates to the approver
   while it is OPEN, SENT_BACK or SUBMITTED. APPROVED and NOT_APPLICABLE never notify. It needs the instance `id`
   (requested from M0 as an additive contract change).

## Consequences
Import flags rules below confidence 1 as `TO_REVIEW`. Consultants can override any inferred rule. Period attribution
for annual filings due after the FY they cover (e.g. a return for FY N due in FY N+1) follows the FY the due date falls
in; a contract change would be needed to express the other attribution.
