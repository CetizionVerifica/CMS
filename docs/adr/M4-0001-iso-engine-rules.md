# M4-0001. ISO engine rules (ENGINE_VERSION 1.1.0)

- Status: accepted
- Date: 2026-10-25
- Module: M4 (`packages/engine`)

## Context
The ISO add-on (plan v2, [M16-0002](M16-0002-iso-plan-v2.md)) puts its formulas and state machines in the engine
(`docs/iso/model.md` §4, §5, §7). Contracts 1.8.0 fix the shapes (`IsoEngineApi` in
`packages/contracts/src/engine-api.ts`), and the M0 mock had to pick readings where the model is silent
(`docs/contracts/iso-mock.md`, "Stand-ins for M4 formulas"). This ADR records the rules the engine implements, so
M16 (API), M9 (reminders), M10 (reports) and M17 (screens) show the same numbers. The statutory functions
(`computeScore`, `deriveStatus`, `planNotifications`) are unchanged; ISO functions sit beside them as `isoEngine`,
which `satisfies IsoEngineApi`. `ENGINE_VERSION` goes from 1.0.0 to 1.1.0: no statutory number moves, so stored
statutory scores stay comparable.

## Decisions

### Risks (`src/iso-score.ts`)
1. **Fixed 5×5 scale.** `riskRating(likelihood, severity)` = likelihood × severity, each an integer 1-5, so 1-25; any
   other value is a `RangeError` (the contract's `RiskScale` already refuses it at the edge). For an OPPORTUNITY the
   second axis is benefit. The scale is not configurable in v1.
2. **Significance.** `isSignificant(item, rule)` with `rule` = `FirmSettings.isoRisk`, default `{ significantAt: 12,
   legalLinkMakesSignificant: true }` (not editable in v1): a set `significantOverride` wins; otherwise significant
   when `rating` (with the existing controls) reaches `significantAt`, or, when the rule says so, when the item links
   at least one statutory obligation. `residualRating` never decides significance.

### Clause readiness and certification gates
3. **Readiness weights.** Assessable clauses only (clauses 1-3 and headings are not assessable). IMPLEMENTED 1,
   PARTIAL 0.5, everything else 0. An APPROVED N/A on an `exclusionAllowed` clause leaves the denominator
   (`excluded`); a REQUESTED N/A counts 0 as `naPending`; an approved N/A on a clause that allows no exclusion, or a
   clause with no row, counts 0 as not started. A rejected N/A counts by its restored status; a withdrawn one is
   NOT_STARTED again. Score = points / counted clauses as a percentage, one decimal, half up (as `computeScore`
   rounds); null when nothing counts. Per standard, in the order the clauses list them, and for the whole system.
4. **Gate window.** Every dated gate reads the 12 months up to `asOf`: after `asOf` − 12 calendar months (day clamped
   to the month end, so 29 Feb 2028 looks back to after 28 Feb 2027), up to and including `asOf`.
5. **The six gates, per standard** (each `{ gate, met, missing[] }`, met exactly when nothing is missing):
   - INTERNAL_AUDIT: REPORTED or CLOSED audits with `reportedOn` in the window together cover (rule 6) every
     assessable clause of the standard that has no approved exclusion, and every unit of the system. `missing` lists
     uncovered clause numbers in reading order ("4.2" before "4.10"), then uncovered unit ids.
   - MANAGEMENT_REVIEW: a HELD or CLOSED review with `heldOn` in the window, covering the standard, with notes on every
     input row of that standard. `missing` is the input keys without notes on the latest such review, or one sentence
     saying no review was held in the window.
   - SCOPE: a non-blank scope statement and at least one unit (`scopeStatement`, `unitIds`).
   - POLICY: an ACTIVE POLICY document with a current (approved) revision linked to the standard's clause 5.2 or a
     5.2.x sub-clause. `missing` is `["5.2"]`.
   - OBJECTIVES: at least one objective for the standard, and every objective without `closedOn` has an action that is
     not CANCELLED (its 6.2.2 plan). `missing` lists the objective ids without one, or a sentence when there is none.
   - RISKS (6.1): a live item of kind RISK or OPPORTUNITY for ISO 9001, ASPECT for ISO 14001, HAZARD for ISO 45001.
     `missing` names the kinds (`["RISK", "OPPORTUNITY"]`, `["ASPECT"]`, `["HAZARD"]`).
   Clause readiness is the client's self-assessment and the gates come from records; neither replaces the other.
6. **Covered.** A clause is covered by a checklist row with result CONFORMS or FINDING of a REPORTED or CLOSED audit; a
   NOT_AUDITED row or an unanswered row covers nothing. A unit is covered when such a row names it, or when the row has
   no unit and its audit lists the unit; a row with no unit in an audit whose unit list is empty covers its clause but
   no unit. `auditProgrammeCoverage` applies the same rule to one FY's programme and counts planned (every audit not
   CANCELLED), reported (REPORTED or CLOSED) and cancelled audits.

### Objectives, incidents and climate
7. **Objective progress** (the mock's stand-in, kept). The latest reading has the latest `periodEnd` on or before
   `asOf` (then the latest `periodStart`); a closed objective is measured by passing its `closedOn` as `asOf`.
   `progressPercent` is the share of the way from baseline to target, clamped to 0-100, one decimal; MAINTAIN, or a
   target equal to the baseline, is 100 when the reading meets the target and 0 otherwise; null without a baseline or a
   reading. `onTrack`: with a baseline, INCREASE and DECREASE compare the reading with the straight line from the
   baseline on `createdOn` to the target on `dueOn`, at the reading's `periodEnd` (the full target from `dueOn` on);
   without a baseline, and for MAINTAIN, the reading must meet the target (MAINTAIN: equal within float noise). Null
   without a reading. `missedReadings` are the periods of `readingRule` due from `createdOn` to the day before
   `asOf`, ending on or after `createdOn`, starting by `dueOn`, that no reading overlaps. Quarters and halves follow
   the client's FY start, passed as `cal` (`{ fyStartMonth }`, default April); reading periods never move for holidays.
8. **Incidents.** `incidentCounts` counts incident NCs by the client-local date of `occurredAt` (`localDateIn`), both
   period days included, in total, by every type and by every outcome with zeros. The caller leaves cancelled NCs out.
9. **Climate (Amd 1:2024, clause 4.1).** UNDECIDED while the decision is null; nothing when decided not relevant; when
   relevant, RELEVANT_NO_RISK without a live climate-related risk item of any kind and RELEVANT_NO_ISSUE without a live
   climate-related context item.

### State machines (`src/iso-status.ts`)
10. **One table per machine.** `ISO_TRANSITIONS` holds every arrow of model §4 (NONCONFORMITY, DOCUMENT_REVISION,
    DOCUMENT, INTERNAL_AUDIT, EXTERNAL_AUDIT, MANAGEMENT_REVIEW, CLAUSE_NA, ISO_ACTION); a new record starts in
    `ISO_NEW_STATE` ("NEW"). `isoTransition(machine, from, action, facts)` answers INVALID_TRANSITION when no arrow
    leaves `from` by `action`, or when a lock guard fails (an OBSOLETE document, a second open revision, SUBMIT,
    APPROVE or SEND_BACK on an EXTERNAL document, RECORD_EDITION on any other, an action whose subject is closed:
    model §1.8). Otherwise it returns the first failed guard with the fields it names, or the next state. `facts` are
    named after the contract fields plus `asOf` and `<what>Count` counts; a missing fact never satisfies a guard, so
    M16 must gather every fact an arrow reads (listed on the table).
11. **Guard readings** (plan v2.2 and the mock's picks, kept): RAISE refuses a `dueOn` before `reportedOn` (README
    decision 51 q); ADD_ROOT_CAUSE needs `rootCauseMethod` and, when a disposition is set,
    `dispositionAuthorisedById`; PLAN_ACTIONS needs `effectivenessDueOn` today or
    later; VERIFY_NOT_EFFECTIVE and REOPEN back to ACTIONS_PLANNED need it after today; VERIFY_EFFECTIVE waits for
    `effectivenessDueOn`, VERIFY_NOT_EFFECTIVE does not; RAISE refuses the same person as owner and approver and an
    audit source unless raised from a finding; document REVIEW needs `nextReviewDueOn` after today; internal REPORT,
    external RECORD_HELD, review RECORD_HELD and action COMPLETE refuse dates after today; an external audit's
    `responseDueOn` is on or after `endOn`; SUBMIT and RECORD_EDITION need exactly one live file on the revision, and
    it CLEAN.
12. **Maker-checker.** `isoMayCheck(machine, action, actorId, history)` reads the record's steps (oldest first, from
    its audit trail): nobody takes a checker step (VERIFY_EFFECTIVE, VERIFY_NOT_EFFECTIVE, revision APPROVE,
    APPROVE_NA) where they took a maker step (ADD_ROOT_CAUSE, PLAN_ACTIONS, SUBMIT, SUBMIT_NO_ACTION, revision
    DRAFT_REVISION and SUBMIT, REQUEST_NA) since the last reset (RAISE, REOPEN, VERIFY_NOT_EFFECTIVE, DRAFT_REVISION,
    REQUEST_NA). DRAFT_REVISION and REQUEST_NA are both a reset and a maker step, so the preparer and the latest
    requester count. False is 403 FORBIDDEN, not a guard. `ISO_APPROVER_STEPS` lists the steps only the record's
    approver, or a client admin as delegate, takes.

### Timing
13. **Due soon and overdue.** One rule for actions, NCs, document and risk reviews, management reviews and
    certificate dates, the same as `deriveStatus` for instances: OVERDUE from the day after the due date, with the days
    past it; DUE_SOON when the due date is at most `dueSoonDays` (`FirmSettings.dueSoonDays`) away, the due date itself
    included; ON_TIME otherwise or with no date; CLOSED for a DONE or CANCELLED action and a CLOSED or CANCELLED NC.
14. **NC status** (the mock's stand-in, kept). The earliest of the NC's `dueOn` (until AWAITING_VERIFICATION) and its
    OPEN actions' due dates decides the timing; `effectivenessOverdueDays` counts from the day after
    `effectivenessDueOn`.
15. **Certification cycle** (the mock's stand-in, kept). Surveillance 1 and 2 are due 12 and 24 calendar months after
    `issuedOn` (month-end clamped: issued 29 Feb 2024, due 28 Feb 2025 and 28 Feb 2026), recertification on
    `expiresOn`. Each is met by the earliest-ending HELD, RESPONDED or CLOSED external audit of that type covering the
    certificate's standard that ended after `issuedOn` (surveillance 2 also after the audit that met surveillance 1;
    ties by id). An audit of the previous cycle meets nothing; one ending after the due date meets it late
    (`daysLate`); an unmet date before `asOf` is overdue. Empty until the certificate is issued.
16. **Management review due.** Per standard of the system, `reviewIntervalMonths` after the last HELD or CLOSED review
    covering it, or after the system's `createdOn` (its `createdAt` as a client-local date) when there is none.

### Reminders (`src/iso-notifications.ts`) and review figures (`src/iso-review.ts`)
17. **Reminder schedule.** `planIsoNotifications(items, ISO_REMINDER_SCHEDULE, asOf)` uses the schedule of model §7 as
    contracts hold it: action due 7 days before and on `dueOn`; action overdue 7 days after; document and risk review
    14 days before and on `reviewDueOn`; internal audit 7 days and 1 day before `plannedStart`; certificate 90, 30 and
    7 days before `expiresOn`; surveillance 60 and 30 days before an unmet cycle date; external response 7 days before
    and on `responseDueOn`; planned management review 14 days before and on `plannedOn`; overdue system review on its
    first overdue day (anchored on `managementReviewDue`'s `nextDueOn`, offset +1), then every 30 days while it stays
    so; effectiveness on `effectivenessDueOn`. An item is sent
    on an offset day or, with `repeatEveryDays`, every that many days after the last offset; an item marked not open,
    or with no rule for its kind and subject type, gets nothing. One notification per distinct recipient per item, so
    two subjects due the same day for one person are two sends.
18. **Review input figures.** `reviewInputFigures(source, data, since, asOf)` counts, both days included, the records
    the caller passes for that source (already narrowed to the reader's unit scope and the input's standards, with
    timestamps turned into client-local dates): the figure keys and readings are the mock's (`docs/contracts/
    iso-mock.md`, "Management review figures"). `since` is the last HELD or CLOSED review covering the input's
    standards, else the system's `createdOn`; a `since` after `asOf` is a `RangeError`. COMPLIANCE_EVALUATION scores
    the STATUTE instances due in the window with `computeScore`; MANUAL has no figures.

### The overview's stand-ins
19. Kept as the mock reads them: the overview's 12-month window is the gate window of rule 4; a certificate is
    expiring when `expiresOn` falls within [as-of, as-of + 90 days]; an NC is overdue past `dueOn` while not CLOSED or
    CANCELLED, and its effectiveness check likewise on `effectivenessDueOn` (rules 13 and 14); POLICY accepts 5.2 or a
    5.2.x sub-clause and OBJECTIVES ignores CANCELLED actions (rule 5). The overview counts are M16's, built on these
    functions; the engine adds no overview function of its own. The review figures' `since` is the caller's (model
    §5.4), so M16 rules on that stand-in.

## Consequences
- M16 gathers the facts each arrow reads and maps a GUARD answer to 400 VALIDATION (422 REASON_REQUIRED for `reason`)
  and a maker-checker refusal to 403. M9 builds `IsoNotificationInput`s and calls `planIsoNotifications` daily.
- `objectiveProgress` takes `createdOn` (a `LocalDate`) and `{ fyStartMonth }` with contracts 1.8.1; the engine
  defaults the FY start to April when it is left out. The mock's stand-ins are all kept, so the M0 mock needs no change.
- Changing any rule here bumps `ENGINE_VERSION` and amends this ADR.
