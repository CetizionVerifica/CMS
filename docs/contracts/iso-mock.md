# ISO mock: readings where the model is silent

The mock (`packages/contracts/src/mock/handlers/iso/`) answers every ISO route. Where `docs/iso/model.md` or plan
§3.2 leaves a rule open, the mock had to pick one. This page lists those picks so M16 (API), M4 (engine) and M17 (web)
can keep them or decide otherwise in an ADR. None of them is a contract shape: the shapes and their departures are in
README decisions 42-51. M4 owns every formula marked "stand-in".

## Shared rules

- **Failed guards** answer `400 VALIDATION` naming the field (model §4 preamble); a wrong state answers
  `409 INVALID_TRANSITION { entity, from, action }`. A write on a record locked by its parent (an obsolete
  document, a closed objective, a closed or cancelled NC or review) names the parent's entity and state with action
  `UPDATE`; an archived parent shows its state as `ARCHIVED`.
- **Reasons.** A field edit audited as `REASSIGN` or `DUE_DATE_CHANGE` without a reason, like a missing cancel or N/A
  reason, is `422 REASON_REQUIRED` (api-conventions.md §5, README decision 51 p), and the event carries the reason.
- **Audit actions.** Owner, lead, chair and approver changes are `REASSIGN`; date moves are `DUE_DATE_CHANGE`; other
  field edits are `UPDATE`; machine steps are `TRANSITION` with `after.action`. A step taken by someone other than the
  person who normally takes it (a client admin or manager as delegate) has `after.delegated: true`. Every checklist row
  a new system makes writes its own `CREATE`. The scan writes no event (M9 owns it). Incident, nonconformity and audit
  finding descriptions are never copied into audit events (non-negotiable 6): a RAISE (by hand, or from an internal or
  external finding, which adds `auditFindingId`) and a finding's `CREATE` leave them out, and an edit of a
  nonconformity's or a finding's description or an incident's location shows `[not recorded]` on both sides.
- **File scans.** A confirmed file is `PENDING` and becomes `CLEAN` (or `INFECTED` for an "eicar" name) on the next
  read of its subject's files or download URL, or when a step relies on it: a revision's SUBMIT or RECORD_EDITION, an
  external audit's RECORD_HELD.

## Stand-ins for M4 formulas

- **Objective progress and on-track**, one rule for the objective view, the systems overview and management review
  figures: the latest reading is the one with the latest `periodEnd` on or before as-of (a closed objective is
  measured as at its `closedOn`). With a baseline, INCREASE and DECREASE compare it with the straight line from the
  baseline on the day the objective was created to the target on `dueOn`, at the reading's `periodEnd`; without a
  baseline, and for MAINTAIN, the reading must meet the target. `missedReadings` are the periods of `readingRule`
  that fell due on or after the creation day and before as-of, ended on or after the creation day, start by `dueOn`,
  and no reading overlaps. The creation day is `createdAt` as a date in the client's time zone (an objective set at
  01:30 IST on 1 April owes no reading for March), and `readingRule` periods follow the client's financial year
  (`fyStartMonth`), as `IsoEngineApi.objectiveProgress` takes them (README decision 51 r).
- **Certification cycle**, one rule for `CertificationView.cycle` and the overview's `cycleOverdue`: surveillance 1
  and 2 due 12 and 24 months after `issuedOn`, recertification on `expiresOn`. Each is met by the earliest HELD,
  RESPONDED or CLOSED external audit of the certificate's system, of that type, covering its standard, that ended
  after `issuedOn` (surveillance 2 also after the audit that met surveillance 1).
- **Programme coverage**, one rule for the programme view and the overview: a clause is covered by a CONFORMS or
  FINDING checklist row of a REPORTED or CLOSED audit; a unit when such a row names it, or the row has no unit and its
  audit lists the unit. Clauses needing coverage are the system's assessable clauses without an approved N/A; units
  are the system's listed units. Uncovered clauses are ordered by standard, then number. Counts of planned, reported
  and cancelled audits include only audits the caller can see; the uncovered lists use all of them.
- **Overview**: the 12-month window is (as-of − 12 months, as-of]. NC overdue = past `dueOn`, not CLOSED or
  CANCELLED; effectiveness overdue likewise on `effectivenessDueOn`. Certificates expiring = `expiresOn` within
  [as-of, as-of + 90 days]. A finding counts for whoever can see its audit (an external one: its system), never by
  its own unit, as the finding lists do. Incidents leave out cancelled NCs and list every type and outcome, zeros included. The
  POLICY gate accepts a link to clause 5.2 or a 5.2.x sub-clause. Objectives without a plan ignore CANCELLED actions.
- **NC status** is OVERDUE when the earliest of `dueOn` (before AWAITING_VERIFICATION) and its OPEN actions' due
  dates is before today.
- **Management review figures** (model §3.13, §5.4). A held review's figures are a record: RECORD_HELD stores each
  non-MANUAL input's figures once, counted up to `heldOn`, with `figuresStoredAt` (when it was recorded held) and the
  engine version `mock-1`, and a HELD or CLOSED review then always answers that copy, whatever changes later. A
  PLANNED review's figures are computed on each read, as of today in the client's time zone, with `figuresStoredAt`
  null, and RECORD_HELD refuses a `heldOn` after that day; a CANCELLED review and a MANUAL input have none. Storing them does not move the input's version, so notes stay
  editable with the version read before. The RECORD_HELD event carries each stored input's key, source, window and
  values, with no ids, and the engine version. The fixture JSON holds no figures: the mock stores those of the
  fixtures' held reviews when it loads, as of their `heldOn`, at their `updatedAt`. Figures count the review's whole
  system with no unit scope (plan §3.3): every reader sees each value, and the ids only of the records they may read,
  so a value can be larger than its list of ids. A record archived since, a compliance instance included, keeps its
  id in the stored copy for whoever may read it, but the id no longer opens, so M17 shows it without a link.
  - **Window.** `since` is worked out per standard of the input: the later of the system's creation day and the
    `heldOn` of the last other HELD or CLOSED review of the system that covers the standard with `heldOn` on or
    before as-of. The input's `since` is the earliest of these, and never after as-of (a review held before its
    system was set up in the app reviews just its own day). At RECORD_HELD the review is still PLANNED, so only
    reviews already held count: one recorded earlier with the same `heldOn` counts as earlier, and a review recorded
    with a `heldOn` before another held review's takes its `since` only from reviews held on or before its own
    `heldOn`, leaving the other's stored figures as they are.
  - **Dates.** Each record is read as it is now, except where its dates place it on as-of, by client-local days. A
    record counts from its creation day; a nonconformity, incidents included, from the later of that and its
    `reportedOn` (which may be backdated). A record archived after as-of counts as live; one archived on or before
    as-of counts only in `contextItemsRemoved`, which lists the items archived in the window. A nonconformity or
    objective with `closedOn` after as-of counts as open, and an action with `doneOn` after as-of as OPEN unless it
    is CANCELLED. The climate decision counts once `climateDecidedOn` is on or before as-of. `readingsRecorded`
    counts the readings created in the window, whatever their period; on-track reads the readings created by as-of
    for periods ended by then.
  - **Events.** Counts with no date field of their own take the client-local days of audited events in the window: a
    context item's `UPDATE` (changed; an item added in the window counts only as added), a risk item's `UPDATE` whose
    `after` names `likelihood`, `severity`, `residualLikelihood` or `residualSeverity` (re-rated; the clearing of a
    residual rating when a treatment action puts the last control in place names its `sourceActionId` and is not
    one), and a nonconformity `TRANSITION` whose `after.action` is VERIFY_NOT_EFFECTIVE (`verifiedNotEffective`
    counts the steps and lists the nonconformities). Everything else is read as it is now: whether a record is
    cancelled, significance, severity, incident outcome, finding type, audit state and, for COMPLIANCE_EVALUATION,
    the instances' workflow, as the core score's as-of does.
  - **Records.** Each source reads the records of the review's system whose standards overlap the input's; an
    internal audit's standards are those of its clauses (its system's when it lists none), and findings follow their
    audit. INCIDENTS uses the overview's rule, so cancelled NCs are left out of both. PREVIOUS_ACTIONS reads the
    review actions of every earlier held review in the window above that covers one of the input's standards.

## Area by area

**Systems and checklist.** `climateDecidedOn` may not be in the future. Only FA, CO and CA change a checklist row's
owner. A management system's `status` has no machine (model §4), so a status change is an `UPDATE`; each N/A step
is a `TRANSITION` whose `after.action` is REQUEST_NA, APPROVE_NA, REJECT_NA or WITHDRAW_NA. APPROVE_NA and REJECT_NA
need the row's units: an approver named as the row's owner but outside the system's
units may not decide (README decision 45). REJECT_NA keeps the request and decision; WITHDRAW_NA clears them. `listIsoChecklist` shows an owner outside the
system's units just their own rows (plan §3.3 named-person exception).

**Documents.** Revision labels are unique per document, ignoring case (`409 DUPLICATE`). REVIEW needs a future
`nextReviewDueOn` and an approved revision. SUBMIT and RECORD_EDITION need exactly one live file on the revision, and
it CLEAN. Maker-checker: nobody who prepared or ever submitted a revision approves it. A second open revision is
`409 INVALID_TRANSITION`. An OBSOLETE document locks everything; its review status is CLOSED. The current revision of
an ACTIVE document is readable by every member; other revisions follow unit scope.

**Risks and objectives.** Legal links must be live STATUTE obligations. An objective's risk items belong to its own
system. With a baseline, an INCREASE objective's target is at or above it and a DECREASE objective's at or below it (a
target equal to the baseline is a level to hold; MAINTAIN, or no baseline, takes any target), so progress and on-track
never disagree: the create body checks it and the update route checks the merged objective, else `400 VALIDATION` on
`target`. A reading's period may not start after today or overlap another reading. `closedOn` lies between the creation
day and today. A risk `unitId` filter matches only the item's own unit.

**Internal audits.** Lead and auditors (approver or owner) may START, REPORT and CLOSE; when that is not the lead it
is `delegated`. Audit people need a live owner-or-higher role in the client, not a unit (independence). Checklist rows
must be for the audit's clauses and units; a unit with rows or findings cannot be dropped. `reportedOn` may not be in
the future.

**Nonconformities.** The NC owner must be an OWNER or CLIENT_ADMIN and its approver an APPROVER or CLIENT_ADMIN
covering its unit, whether raised by hand, from an internal finding or from an external one. The PATCH route is the
owner's and a CA's (investigation fields); the reassign route is FA's, CO's and CA's (owner, approver, dates,
severity and the incident outcome, with a reason). Severity and outcome change only while OPEN or ROOT_CAUSE_FOUND;
`lostDays` moves with the outcome on reassign, and alone only on the PATCH while the outcome stays LOST_TIME. A
finding's NC refuses a severity change, and an NC without incident fields refuses an outcome, `400` in any open
state (CLOSED or CANCELLED answers `409 INVALID_TRANSITION` first).
VERIFY_EFFECTIVE re-checks the SUBMIT_NO_ACTION rule on an NC submitted with none (the later of SUBMIT and
SUBMIT_NO_ACTION in its trail), to catch rows changed outside these routes. VERIFY_NOT_EFFECTIVE
may come before `effectivenessDueOn`; VERIFY_EFFECTIVE waits for it. `effectivenessDueOn` can move but never be cleared
or set in the past. Severity of an NC raised from a finding follows the finding's type alone: the finding's MAJOR_NC/MINOR_NC move is
refused once the NC has left OPEN or ROOT_CAUSE_FOUND (`409 INVALID_TRANSITION`, entity `nonconformity`, action
`UPDATE`) and for the NC's owner (`403 FORBIDDEN`, whatever the state); the owner's other edits of the finding stand. REOPEN clears `effective`, and back to OPEN also
clears `effectivenessDueOn`; controls added by a reopened treatment action stay. Actions on a closed subject can be
cancelled but not completed, edited or reopened.

**Certifications.** RECORD_HELD needs a live report file not INFECTED or FAILED, and `endOn` by today;
`responseDueOn` is on or after `endOn`. Findings are created and edited only while HELD. RECORD_RESPONSE needs no OPEN
NC; CLOSE from HELD needs no finding that raised one, and a recommendation. An external NC's unit is the system's only
unit, else none.

**Management reviews and files.** A CANCELLED review is locked like a CLOSED one. The chair (or FA, CO, CA) edits
attendees and minutes until it is CLOSED or CANCELLED; replanning is FA's, CO's and CA's, only while PLANNED. Changing
standards while PLANNED archives the rows of keys no longer wanted and adds rows for new keys; a key added back gets a
new row, and the archived one keeps its notes. A HELD review keeps every input's notes. Only
the person who asked for an upload ticket confirms it. FA and CO read but do not add or remove files on an NC. The
incident restriction on downloads covers files on the incident NC's actions too.

**Core routes with the switch off.** By-id routes check scope and role first, then the switch, so a 403 never reveals
that an id the caller cannot see is an ISO activity. `source` is ignored while off. Acts of different kinds never
merge, an obligation never moves to an act of another kind, a STANDARD act stays CENTRAL, and act names are unique per
kind. The client overview's `upcoming` and `myTasks` read STATUTE instances only, like its score.
