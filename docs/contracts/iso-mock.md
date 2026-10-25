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
- **Management review figures**: `since` is the standard's last HELD or CLOSED review of the same system before this
  one, else the system's creation day, and never after as-of (a review held before its system was set up in the app
  reviews just its own day). As-of is the review's `heldOn` once it is held (the window it reviewed), else today (a
  PLANNED review, or a CANCELLED one, which was never held). A held review's figures read the records as they stood
  on its `heldOn`: a record counts once it was created by then (a nonconformity, incidents included, once reported),
  and a field takes the `before` value of its first audited change on a later client-local day, else its value now.
  So open, overdue, done, cancelled, significance, severity, incident outcome, an objective's target and readings, an
  audit's state, report date and visit dates, a finding's type and the climate decision are those of `heldOn`, and a
  context item is changed in the window by an audited UPDATE in it. A row with no trail is read by its dates
  (`closedOn`, `doneOn`, `updatedAt`, and for a cancel its last change, since a cancelled record takes no edits); a
  cancel counts from its CANCEL step, so a row cancelled before its trail began and reopened later reads as not
  cancelled. A review not held reads every record as it is now. Archived records appear in no figure but
  `contextItemsRemoved`, whatever the day, since their ids no longer open. COMPLIANCE_EVALUATION reads the instances'
  workflow as it is now, as the core score's as-of does. Figures count only records the caller can see
  and whose standards overlap the review's; an internal audit's standards are those of its clauses (its system's when
  it lists none), and findings follow their audit. INCIDENTS uses the overview's rule, so cancelled NCs are left out
  of both. `readingsRecorded` counts every reading recorded in the window, whatever its period; on-track reads only
  periods ended by as-of.

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
standards while PLANNED archives the rows of keys no longer wanted and adds rows for new keys. A HELD review keeps every input's notes. Only
the person who asked for an upload ticket confirms it. FA and CO read but do not add or remove files on an NC. The
incident restriction on downloads covers files on the incident NC's actions too.

**Core routes with the switch off.** By-id routes check scope and role first, then the switch, so a 403 never reveals
that an id the caller cannot see is an ISO activity. `source` is ignored while off. Acts of different kinds never
merge, an obligation never moves to an act of another kind, a STANDARD act stays CENTRAL, and act names are unique per
kind. The client overview's `upcoming` and `myTasks` read STATUTE instances only, like its score.
