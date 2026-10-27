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
- **The client audit trail.** Since 1.8.3 the ISO events are in firm B's `auditEvents` with the client's other events,
  so `GET /clients/{clientId}/audit` lists and filters them, with the add-on on or off (plan §4.4). The fixture's
  sample trail (fixtures.md §8) loads with them. The mock's clock does not move, so both trails list the events of
  one instant newest first, in reverse order of writing (1.8.4).
- **Lists by id.** The nonconformity, risk, objective, document and internal audit lists take `ids` as endpoints.md
  §10 says (1.8.5):
  the mock applies it with the list's other filters and the reader's units, and the document list keeps its
  ACTIVE-only default only when neither `status` nor `ids` is given.
- **ISO exports.** The mock writes no file: an ISO export kind is checked (its filters against `ISO_EXPORT_FILTERS`, by
  the body schema), kept as a `DONE` job named `iso-...-<today>.xlsx` or `.pdf` and audited as `EXPORT`. While the
  add-on is off, its create, job read and download URL answer `403 FEATURE_NOT_ENABLED` after the role check; the
  mock does not check that the audit or review a PDF names exists or is in the reader's units (M10 does, ISO-11d).
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
  null, and RECORD_HELD refuses a `heldOn` after that day; a CANCELLED review and a MANUAL input have none. Storing
  them does not move the input's version, so notes stay editable with the version read before. The RECORD_HELD event
  carries each stored input's key, source, window and values, with no ids, and the engine version. The fixture JSON
  holds no figures: the mock stores those of the fixtures' held reviews when it loads, as of their `heldOn`, at their
  `updatedAt`, in that order (ties by id), each counting as earlier only the reviews stored before it, so two held on
  one day get the same figures on every load. The mock works as M3 and M4 will (ISO-1a3): it gathers each input's
  `ReviewFigureData` from the store and its audit trail, as ISO-2h's gather will, then computes the figures from that
  data and the window alone, typed as `TypedReviewInputFigures`, as ISO-3b's engine does.
  - **Window.** `since` is worked out per standard of the input: the later of the system's creation day and the
    `heldOn` of the last other HELD or CLOSED review of the system that covers the standard with `heldOn` on or
    before as-of. The input's `since` is the earliest of these, and never after as-of. At RECORD_HELD the review is
    still PLANNED, so only reviews already held count: one recorded earlier with the same `heldOn` counts as earlier,
    and a review recorded with a `heldOn` before another held review's takes its `since` only from reviews held on or
    before its own `heldOn`, leaving the other's stored figures as they are. A review held before its system's
    creation day stores no figures (the app held none of its records then): its rows keep null figures and its
    RECORD_HELD event carries `figures: []`. One held on that day stores the figures of that one day.
  - **Dates.** Each record is read as it is now, except where its dates place it on as-of, by client-local days. A
    record counts from its creation day. A date the user enters places its record by the later of that date and the
    day of the step that set it, the latest such step, so a record settled or entered after a review was recorded,
    dated before it, counts in the next review instead of in neither: an action's settled day is the later of
    `doneOn` and its COMPLETE step when DONE, and its CANCEL step when CANCELLED (the latest, so one completed,
    reopened and completed again counts by the later COMPLETE), and it is OPEN on as-of until then; an objective's
    CLOSE step with `closedOn` (open on as-of until then); an internal audit's REPORT step with `reportedOn`; and an
    external audit's `endOn` with the latest event that set it, its RECORD_HELD or a later `UPDATE` naming `endOn`
    (the visit's dates stay editable while HELD or RESPONDED; moved after a review counted it, the audit and its
    findings count again in the next one, and the stored ids show it). A row seeded or loaded without that step in
    its trail takes its `createdAt` as the step's time, so it is placed by the later of its entered date and its
    creation day. `createdAt` never changes, so the row is placed once; `updatedAt` is not used, since any later write
    (an internal audit's CLOSE, an external audit's RECORD_RESPONSE, a system PATCH) moves it. A nonconformity, incidents included, is raised and
    counts from its counting day, the later of its creation day and its `reportedOn` (which may be backdated), and an
    incident is placed by that day too (its `occurredAt` day is never later, below); a finding by the later of its
    audit's day and its own creation day, whether or not its audit counts in the window. DONE and CANCELLED review
    actions (PREVIOUS_ACTIONS), and DONE treatment actions (RISKS, which has no cancelled figure), count only when
    their settled day is in the window, so an action settled before `since` is not counted again. A record reopened since is read as it is now: REOPEN clears an action's
    `doneOn` and a nonconformity's `closedOn`, so live figures for any as-of read either as open. A record archived
    after as-of counts as live; one archived on or before as-of counts only in `contextItemsRemoved`, which lists the
    items archived in the window. `correctiveActionsOverdue` counts only the actions of nonconformities open on as-of.
    `readingsRecorded` counts the readings created in the window, whatever their period; on-track reads the readings
    created by as-of for periods ended by then.
  - **Climate.** Each management system `UPDATE` naming `climateChangeRelevant`, `climateChangeRationale` or
    `climateDecidedOn` is a decision on its own day. Only the climate route writes them, and only for the fields it
    changes, so every call that changes any of the three is a decision: a new rationale alone, with the same
    relevance and date, is one too. `climateDecided` counts from the first decision on or before as-of, so a
    decision changed after as-of still counts; `climateDecidedInPeriod` counts when any decision falls in the window;
    `climateRelevant` reads the decision as it is now. A system seeded or loaded decided has that decision too, when
    its trail has no decision or its first does not move `climateChangeRelevant` from null (its events are then later
    decisions): placed by the later of the `climateDecidedOn` it was seeded with (the `before` of the decisions since
    gives it back) and its creation day.
  - **Events.** Counts with no date field of their own take the client-local days of audited events in the window: a
    context item's `UPDATE` (changed; an item added in the window counts only as added), a risk item's `UPDATE` whose
    `after` names `likelihood`, `severity`, `residualLikelihood` or `residualSeverity` (re-rated; the clearing of a
    residual rating when a treatment action puts the last control in place names its `sourceActionId` and is not
    one), and a nonconformity `TRANSITION` whose `after.action` is VERIFY_NOT_EFFECTIVE (`verifiedNotEffective`
    counts the steps and lists the nonconformities). Everything else is read as it is now: whether a record is
    cancelled, significance, severity, incident outcome, finding type, audit state and, for COMPLIANCE_EVALUATION,
    the instances' workflow, as the core score's as-of does.
  - **Records.** Each source reads the records of the review's system whose standards overlap the input's. A RISKS
    input reads the kinds of its key (`reviewRiskKinds`): SIGNIFICANT_ASPECTS aspects only, RISKS_AND_OPPORTUNITIES
    risks and opportunities, and hazards too when ISO 45001 is among the input's standards, and RISK_ACTIONS risks and
    opportunities. It has a `significant<Kind>` figure only for those kinds, so a 14001 review's two RISKS rows never
    count, or show a zero for, each other's items. An
    internal audit's standards are those of its clauses (its system's when it lists none), and a finding's those of
    its clauses (its audit's when it lists none), so a 9001-only input counts no finding on a 14001 clause.
    INCIDENTS uses the overview's rule, so cancelled NCs are left out of both. PREVIOUS_ACTIONS reads the review
    actions of every earlier held review in the window above that covers one of the input's standards.
  - **Readers.** Figures count the review's whole system with no unit scope (plan §3.3): every reader sees each
    value, and the ids only of the records they may read in the table `REVIEW_FIGURE_KEYS` names for the key (none
    for the score), so a value can be larger than its list of ids. A record archived since, a compliance instance
    included, keeps its id in the stored copy for whoever may read it, but the id no longer opens, so M17 shows it
    without a link. Incidents are the limit (model §3.13 item 4): when cutting an INCIDENTS row's ids for a reader
    drops any id, the row answers `figuresWithheld: true`, with no `sourceFigures`, `figuresStoredAt` or `notes`,
    unless the reader chairs or attends the review. The mock reads the ids the row counts, so a system whose units
    were narrowed after an incident was counted still withholds it from an owner of the remaining units; a row with
    no figures, and a client-wide reader, never are.

## Area by area

**Systems and checklist.** `climateDecidedOn` may not be in the future. REQUEST_NA on a clause that allows no
exclusion answers `400 VALIDATION` naming `status`, as the engine's guard and the API do (ADR M16-0004 decision 5;
before 1.8.5 the mock named `clauseId`). Only FA, CO and CA change a checklist row's
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
state (CLOSED or CANCELLED answers `409 INVALID_TRANSITION` first). An NC is reported on the client-local day it is
raised, by hand or from a finding (since 1.8.5; before, the mock's one zone, Asia/Kolkata). An incident's `occurredAt`
may not be after now, compared as instants, nor its client-local day after the NC's `reportedOn` (`400 VALIDATION` on
RAISE and on the PATCH, model §3.11); the mock checks it only when RAISE or the PATCH sets a new time, so a row loaded
before 1.8.4 keeps its time until then.
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
