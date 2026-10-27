# M16-0008: Management reviews, review figures and the overview in the ISO API, part 3, and where they depart from the mock

Status: accepted, 2026-10-27. Package ISO-8c, part 3 of 3 (`docs/iso/packages.md`). Plan: `docs/iso/plan.md` §3.2-3.3
(the review figures' exception); model §1.9, §3.13, §4 preamble, §4.5, §5.1, §5.2, §5.4, §6 and §8;
`docs/contracts/iso-mock.md` ("Shared rules", "Management reviews and files", the "Overview", "NC status" and
"Management review figures" stand-ins); ADR M16-0003.

## Context

The last part of ISO-8c serves, from Postgres:

- management reviews with their input and output rows, through every arrow of model §4.5, using the engine's
  `ISO_TRANSITIONS.MANAGEMENT_REVIEW`;
- the review's PATCH (attendees and minutes) and its replan route (standards, date and chair);
- each input's figures, from ISO-2h's `reviewFigures.gather` and the engine's `reviewInputFigures`;
- files on management reviews;
- the ISO overview.

With it every ISO add-on endpoint of the contract is served; the file routes mount when the server is given an
`IsoFiles`, which the integrated app gets in ISO-14b. None of the decisions below changes a contract shape.

## Decisions

1. **Steps go through the engine.**
   - CANCEL, RECORD_HELD and CLOSE call `isoTransition` with the review's facts:
     - CANCEL: the reason;
     - RECORD_HELD: `heldOn`, the client-local today as `asOf`, how many attendees the review will have, and how many
       input rows have no notes;
     - CLOSE: how many output rows have no decision, and how many of the review's actions are OPEN.
   - A failed guard answers `400 VALIDATION` naming the guard's first field (`heldOn`, `attendeeIds`, `inputs`,
     `outputs`, `actions`), with the guard's own message, as parts 1 and 2 do. The mock also lists the input or output
     keys still missing notes or a decision; M16's message does not.

2. **The steps on offer.** A review offers the arrows that leave its state. CANCEL goes to whoever may plan it
   (`isoReview.plan`: FA, CO, CA); RECORD_HELD and CLOSE go to whoever may write it (`isoReview.write`: a manager, or an
   approver or owner who chairs it; an attendee is not "own"). No facts are read, so RECORD_HELD is offered before every
   input has notes, as in the mock.

3. **Delegation.** PLAN and CANCEL are marked `delegated` when the actor is not a client admin; RECORD_HELD and CLOSE
   when the actor is neither the chair nor a client admin, as model §4 preamble and the mock have it.

4. **Figures.**
   - A PLANNED review's figures are computed on each read as of the client-local today; a HELD or CLOSED review's are
     the stored copy, never recomputed. A CANCELLED review and a MANUAL input have none.
   - RECORD_HELD stores each live non-MANUAL row's figures as of `heldOn` inside its own transaction, while the review
     is still PLANNED, through `reviewInputs.storeFigures` with `ENGINE_VERSION`. A review held before its system's
     creation day (client-local) stores none: the app held none of its records then.
   - `figuresStoredAt` is the time the repository stores them (the database's clock in that transaction). The mock uses
     its own clock; in a running app the two are the same moment.
   - The TRANSITION event carries each stored row's key, source, window and values with no ids, and the engine version
     (model §8).
   - Every figure's ids are cut through `isoVisibleIds` with the table `REVIEW_FIGURE_KEYS` names, for every reader. A
     key with no table lists no ids. The INCIDENTS row is withheld (`figuresWithheld`, with no figures or notes) when
     the cut drops any id and the reader neither chairs nor attends the review (model §3.13 item 4). The cut reads the
     records' units now, so narrowing a system's units never shows a reader more than before.

5. **Replan.** While PLANNED only (`409 INVALID_TRANSITION` with action `UPDATE` otherwise). A changed set of standards
   goes through ISO-2h's `syncForReview`; the UPDATE event names the standards and the keys added and removed
   (`inputKeysAdded`, `inputKeysRemoved`, `outputKeysAdded`, `outputKeysRemoved`, only those with keys). A new date is
   its own DUE_DATE_CHANGE event and a new chair its own REASSIGN event, each with the reason. A standard added back
   gets a new row with no notes.

6. **Rows.** Input and output rows are listed in the contract's key order with every clause reference of their key
   among the review's standards. Their edits are UPDATE events on the review (`{ input, notes }`,
   `{ output, decision }`), since rows have no entity type of their own. A held review keeps notes on every input and at
   least one attendee (`400 VALIDATION`), as the mock does.

7. **Files on a review.** `isoReview.write` with the chair as "own"; an attendee reads them but does not change them.
   CLOSED and CANCELLED lock them (model §6). Every file subject of the contract now has its rules, so the file routes'
   "not yet" answer (`400 VALIDATION` on `subject`) is gone; an unknown review id is `404`.

8. **Overview.**
   - Systems the actor can see (the systems list's unit scope), by name then id; `managementSystemId` narrows them.
   - `asOf` only for FA, CO and VIEWER; anyone else who sets it gets `403 FORBIDDEN` with action `isoSystem.read`, the
     endpoint's own action. The mock names `report.asOf`, which is not an `Action` of the policy.
   - Counts list only records the actor may read, through the same scoped repository reads as the lists (plan §3.3).
     The readiness gates, the programme's uncovered lists and the certificate cycle dates read every record of the
     system, as the mock does.
   - **NC overdue comes from the engine** (root rule 3), as contracts 1.8.6 defines it: an open NC counts when
     `nonconformityStatus` gives OVERDUE, so the earliest of its `dueOn` (until AWAITING_VERIFICATION) and its OPEN
     actions' due dates is past, the same NCs the NC list's `overdue=true` gives the same reader. The mock's overview
     counts only a past `dueOn` until ISO-1c2. Effectiveness overdue is the engine's `effectivenessOverdueDays`; actions,
     documents and risks use `actionStatus` and `reviewDue`; objectives are off track when `objectiveProgress` says so.
   - `clauseReadiness` reads the clauses in the system's `standardIds` order, so `byStandard` follows it.
     `certificationReadiness` gets one review input entry per standard of the review that defines the row's key.
   - Incidents are those of the client's current FY with cancelled NCs left out; the audit programme is the current
     FY's, or null.

9. **Security sweep.** Firm A gets a management review with its first input and output row through the API, and every
   new write has a `BODIES` entry. Its external audit is now HELD with an OFI finding of its own, so
   `updateIsoExternalFinding` is swept with a real external finding (the #325 e2e audit, Low). RECORD_HELD needs the
   body's report file, and the integrated app serves no ISO file routes until ISO-14b gives it an `IsoFiles`, so the
   spec writes one clean `iso_file` row straight to the database in firm A's tenant context, as an upload the scan job
   passed would leave it. `UNMOUNTED` now holds only the five file routes.

## Consequences

- ISO-8c is complete; the add-on's API matches the contract with the departures above and those of M16-0004 to
  M16-0007.
- A later change to these rules is a new M16 ADR.
