# M16-0007: Audit programmes, internal audits and findings in the ISO API, part 3, and where they depart from the mock

Status: accepted, 2026-10-27. Package ISO-8c, part 2 of 3 (`docs/iso/packages.md`). Plan: `docs/iso/plan.md` §3.2-3.3;
model §3.7, §3.8, §3.9, §4 preamble, §4.3, §4.4, §5.1, §6 and §8; `docs/contracts/iso-mock.md` ("Shared rules",
"Audits", "Certifications", "Management reviews and files").

## Context

The second part of ISO-8c serves, from Postgres:

- audit programmes;
- internal audits, through every arrow of model §4.3, using the engine's `ISO_TRANSITIONS.INTERNAL_AUDIT`;
- their checklists and findings;
- the findings of external audits;
- the two external-audit arrows ISO-8a left out, RECORD_RESPONSE and CLOSE;
- files on internal audits and on audit findings.

A MAJOR_NC or MINOR_NC finding raises its nonconformity through part 1's `raiseNonconformity`. None of the decisions
below changes a contract shape.

## Decisions

1. **Steps go through the engine.**
   - START, REPORT, CLOSE and CANCEL on an internal audit, and RECORD_RESPONSE and CLOSE on an external one, call
     `isoTransition` with the record's facts:
     - REPORT: the summary, `reportedOn`, how many people it is reported to, unanswered clauses, and NOT_AUDITED rows
       without a reason;
     - CLOSE on an internal audit: the nonconformities its findings raised that are still OPEN;
     - RECORD_RESPONSE: the same count for an external audit;
     - CLOSE on an external audit: the recommendation, and how many findings raised a nonconformity.
   - A failed guard answers `400 VALIDATION` naming the guard's first field, with the guard's own message, as part 1
     does. So REPORT's checklist answer says "Answer a checklist row for every clause of the audit"; the mock also
     lists the missing clause numbers.

2. **The steps on offer.**
   - An internal audit offers the arrows that leave its state. START, REPORT and CLOSE go to whoever may conduct it
     (`isoAudit.conduct`, with the lead auditor and auditors as "own"); CANCEL goes to whoever may plan it
     (`isoAudit.plan`).
   - No facts are read, so REPORT is offered before the checklist is complete, as in the mock.
   - An external audit now offers RECORD_RESPONSE while HELD, CLOSE while HELD when no finding raised a nonconformity,
     and CLOSE while RESPONDED. This is ADR M16-0004 decision 3, now that the routes exist.

3. **Delegation follows the mock.**
   - START and REPORT are delegated unless the lead auditor takes them.
   - CLOSE is delegated unless the lead auditor or a client admin takes it.
   - CANCEL on an internal audit, and every external-audit step, are delegated unless a client admin takes them.

4. **A finding's nonconformity.**
   - The database assigns ids, and a finding stores its nonconformity's id. So the nonconformity is raised first,
     without an event (`fromFinding`), then the finding is stored. `auditRaised` then writes the RAISE event, with
     `auditFindingId` naming the finding, before the finding's own CREATE.
   - The owner, approver and due date are checked first, on the nested paths the mock uses: `['nonconformity',
     'ownerId']`, `['nonconformity', 'approverId']` and `['nonconformity', 'dueOn']`. The owner is an OWNER or client
     admin covering the nonconformity's unit, and the approver an APPROVER or client admin.
   - The unit is:
     - for an internal finding, the finding's own, else the audit's single unit;
     - for an external finding, the finding's own, else the system's single unit.
   - The standards are those of the finding's clauses. With no clauses, an internal finding takes the standards of
     the audit's clauses, else the system's; an external finding takes the audit's standards.
   - Neither event copies the description.

5. **Finding type moves.**
   - One function, `editFinding`, serves internal and external findings. A type moves only within its family:
     OBSERVATION, OFI and GOOD_PRACTICE, or MAJOR_NC and MINOR_NC.
   - It cannot move to GOOD_PRACTICE while an action on the finding is not cancelled.
   - An NC-type move changes the nonconformity's severity in an UPDATE event of its own. The nonconformity's owner is
     refused with 403, naming the route's action. Once the nonconformity is past ROOT_CAUSE_FOUND, the move is refused
     with 409 (`nonconformity`, `UPDATE`).
   - The description is written as `[not recorded]` in the finding's UPDATE event, as in part 1.

6. **Programme coverage.**
   - The engine's `auditProgrammeCoverage` runs twice:
     - over all of the programme's audits, for the uncovered clauses and units;
     - over the audits the actor may see, for the planned, reported and cancelled counts, as in the mock.
   - Clauses are the live clauses of the system's standards. A clause counts as excluded when `exclusionAllowed` is
     set and the system's checklist row for it has an approved N/A.

7. **Lists.**
   - Programmes: one per system and FY. Creating a duplicate answers `409 DUPLICATE` with `field: 'fy'` and the
     existing programme's `existingId`. The list covers programmes of archived systems too, as the mock's does, newest
     FY first, then by creation; M16 pages it.
   - Internal audits: `ids`, programme, system, state, the planned-start range and the unit scope are filtered in SQL.
     The lead auditor (`me` included), the unit (an audit with no units of its own covers its system's units) and
     `q` (title and summary) are filtered in memory. The list is then sorted by planned start, title and creation, and
     M16 pages it, so filtering never leaves a short page.
   - Checklist rows are ordered by the account's catalogue order (standard code, edition, clause number), then by
     creation. Findings are listed oldest first.

8. **Unit moves.**
   - A PATCH that changes an internal audit's units authorizes `isoAudit.plan` again on the new units, naming nobody,
     as ADR M16-0006 decision 7 does for risk items and nonconformities.
   - Today every planner (FA, CO, CA) covers the whole client, so this is a guard for later roles.
   - A unit that a checklist row or finding sits on cannot be dropped.
   - Checklist rows and findings take the audit's reach, so moving one of them within the audit's units authorizes
     nothing new.

9. **People and links are checked when they change.**
   - An audit's lead auditor, auditors, auditees and people reported to must hold a named role in the client. No unit
     is checked: auditors come from other units for independence.
   - On a PATCH or REPORT only newly named people are checked, as part 1 checks an NC's people. Someone named before
     whose role later lapsed does not block an edit to other fields.
   - A checklist row's `findingId` must be a live finding of the same audit. It is checked whenever the link changes.

10. **Files.**
    - An internal audit, and each of its findings, takes files from its audit team (`isoAudit.conduct`). It is locked
      once the audit is REPORTED, CLOSED or CANCELLED.
    - An external audit's finding takes files from managers (`isoCertification.write`). It is locked once the visit
      is CLOSED or CANCELLED.
    - Management reviews remain part 3's.

11. **External audits.**
    - A PATCH that changes `standardIds` is refused (400 on `standardIds`) when a finding of the audit names a clause
      of a standard it would drop.
    - Moving `endOn` while HELD or RESPONDED writes one UPDATE. Moving `responseDueOn` in the same PATCH writes its
      own DUE_DATE_CHANGE, with the reason.

12. **The e2e sweep.** `fill` now looks an id up by `<parent>/<segment>` before trying `<segment>`, so that
    `/internal-audits/{id}/checklist/{itemId}` names an audit checklist row and not a system checklist row.
    - An external finding needs a HELD visit, and a HELD visit needs the body's report file. The file routes are not
      mounted in the integrated run until ISO-15, so the external finding routes name firm A's internal finding,
      which is still one of firm A's records.

## Consequences

- Part 3 adds management reviews, their figures and the overview, and the `management_review` file subject.
- ISO-8c counts as merged only when part 3 lands.
