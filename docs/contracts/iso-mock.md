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
- **Reasons.** A moved date or a reassignment without a reason, like a missing cancel or N/A reason, is
  `422 REASON_REQUIRED` (api-conventions.md §5).
- **Audit actions.** Owner, lead, chair and approver changes are `REASSIGN`; date moves are `DUE_DATE_CHANGE`; other
  field edits are `UPDATE`; machine steps are `TRANSITION` with `after.action`. A step taken by someone other than the
  person who normally takes it (a client admin or manager as delegate) has `after.delegated: true`. Every checklist row
  a new system makes writes its own `CREATE`. The scan writes no event (M9 owns it). Incident and NC descriptions are
  never copied into audit events (non-negotiable 6).
- **File scans.** A confirmed file is `PENDING` and becomes `CLEAN` (or `INFECTED` for an "eicar" name) on the next
  read of its subject's files or download URL, or when a step relies on it: a revision's SUBMIT or RECORD_EDITION, an
  external audit's RECORD_HELD.

## Stand-ins for M4 formulas

- **Objective progress and on-track**, one rule for the objective view, the systems overview and management review
  figures: the latest reading is the one with the latest `periodEnd` on or before as-of (a closed objective is
  measured as at its `closedOn`). With a baseline, INCREASE and DECREASE compare it with the straight line from the
  baseline on the day the objective was created to the target on `dueOn`, at the reading's `periodEnd`; without a
  baseline, and for MAINTAIN, the reading must meet the target. `missedReadings` are the periods of `readingRule`
  that ended on or after the creation day, start by `dueOn`, fell due before as-of, and no reading overlaps.
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
  [as-of, as-of + 90 days]. Incidents leave out cancelled NCs and list every type and outcome, zeros included. The
  POLICY gate accepts a link to clause 5.2 or a 5.2.x sub-clause. Objectives without a plan ignore CANCELLED actions.
- **NC status** is OVERDUE when the earliest of `dueOn` (before AWAITING_VERIFICATION) and its OPEN actions' due
  dates is before today.
- **Management review figures**: `since` is the standard's last HELD or CLOSED review of the same system before this
  one, else the system's creation day. Figures count only records the caller can see and whose standards overlap the
  review's.

## Area by area

**Systems and checklist.** `climateDecidedOn` may not be in the future. Only FA, CO and CA change a checklist row's
owner. REJECT_NA keeps the request and decision; WITHDRAW_NA clears them. `listIsoChecklist` shows an owner outside the
system's units just their own rows (plan §3.3 named-person exception).

**Documents.** Revision labels are unique per document, ignoring case (`409 DUPLICATE`). REVIEW needs a future
`nextReviewDueOn` and an approved revision. SUBMIT and RECORD_EDITION need exactly one live file on the revision, and
it CLEAN. Maker-checker: nobody who prepared or ever submitted a revision approves it. A second open revision is
`409 INVALID_TRANSITION`. An OBSOLETE document locks everything; its review status is CLOSED. The current revision of
an ACTIVE document is readable by every member; other revisions follow unit scope.

**Risks and objectives.** Legal links must be live STATUTE obligations. An objective's risk items belong to its own
system. A reading's period may not start after today or overlap another reading. `closedOn` lies between the creation
day and today. A risk `unitId` filter matches only the item's own unit.

**Internal audits.** Lead and auditors (approver or owner) may START, REPORT and CLOSE; when that is not the lead it
is `delegated`. Audit people need a live owner-or-higher role in the client, not a unit (independence). Checklist rows
must be for the audit's clauses and units; a unit with rows or findings cannot be dropped. `reportedOn` may not be in
the future.

**Nonconformities.** The NC owner must be an OWNER or CLIENT_ADMIN and its approver an APPROVER or CLIENT_ADMIN
covering its unit, whether raised by hand, from an internal finding or from an external one. The PATCH route admits FA
and CO for owner, approver and dates only (`isoNc.reassign`), and OW only for investigation fields. VERIFY_NOT_EFFECTIVE
may come before `effectivenessDueOn`; VERIFY_EFFECTIVE waits for it. `effectivenessDueOn` can move but never be cleared
or set in the past. Severity of an NC raised from a finding is fixed. REOPEN clears `effective`, and back to OPEN also
clears `effectivenessDueOn`; controls added by a reopened treatment action stay. Actions on a closed subject can be
cancelled but not completed, edited or reopened.

**Certifications.** RECORD_HELD needs a live report file not INFECTED or FAILED, and `endOn` by today;
`responseDueOn` is on or after `endOn`. Findings are created and edited only while HELD. RECORD_RESPONSE needs no OPEN
NC; CLOSE from HELD needs no finding that raised one, and a recommendation. An external NC's unit is the system's only
unit, else none.

**Management reviews and files.** A CANCELLED review is locked like a CLOSED one. Changing standards while PLANNED
archives the rows of keys no longer wanted and adds rows for new keys. A HELD review keeps every input's notes. Only
the person who asked for an upload ticket confirms it. FA and CO read but do not add or remove files on an NC. The
incident restriction on downloads covers files on the incident NC's actions too.

**Core routes with the switch off.** By-id routes check scope and role first, then the switch, so a 403 never reveals
that an id the caller cannot see is an ISO activity. `source` is ignored while off. Acts of different kinds never
merge, an obligation never moves to an act of another kind, a STANDARD act stays CENTRAL, and act names are unique per
kind. The client overview's `upcoming` and `myTasks` read STATUTE instances only, like its score.
