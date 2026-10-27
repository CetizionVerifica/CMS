# M16-0006: Nonconformities in the ISO API, part 3, and where they depart from the mock

Status: accepted, 2026-10-27. Package ISO-8c, part 1 of 3 (`docs/iso/packages.md`). Plan: `docs/iso/plan.md` §3.2-3.3;
model §3.10, §3.11, §4 preamble, §4.1, §6 and §8; `docs/contracts/iso-mock.md` ("Shared rules", "Nonconformities",
"Management reviews and files").

## Context

ISO-8c is 48 routes, so it ships in three parts, each a combined PR with its e2e sweep: nonconformities first (13
routes and their files), then programmes, internal audits and audit findings, then management reviews, their figures
and the overview. This part serves nonconformities, incidents and near misses from Postgres: RAISE and every arrow of
model §4.1 through the engine's `ISO_TRANSITIONS.NONCONFORMITY`, maker-checker through `isoMayCheck`, timing through
`nonconformityStatus`, the investigation PATCH (`isoNc.work`), the reassign route (`isoNc.reassign`) and files on a
nonconformity. It also closes the three follow-ups of the #320 audit. None of the decisions changes a contract shape.

## Decisions

1. **Who owns and approves a nonconformity.** As the mock does, an NC's owner is an OWNER or CLIENT_ADMIN and its
   approver an APPROVER or CLIENT_ADMIN covering its unit, the roles that `isoNc.work` and `isoNc.verify` let act,
   checked through M3's `memberships.holdsRole` (with the person's own state, so an archived or DISABLED person is
   refused). Investigators and who authorised a disposition may hold any role but viewer. So the brief's test of a
   client admin naming a consultant of the client is met by naming one as an investigator; a consultant is never an
   NC's owner, since no grant would let them take its owner's steps.

2. **One field per failed guard.** Each arrow answers the first guard the engine reports, as `400 VALIDATION` naming
   that guard's first field (`422 REASON_REQUIRED` for a reason), with the guard's own message, as ISO-8a's and
   ISO-8b's arrows do. The mock gathers every failing field of ADD_ROOT_CAUSE, SUBMIT and SUBMIT_NO_ACTION into one
   answer. The paths name the field alone (`incident.outcome`, not `body.incident.outcome`), as everywhere in M16.

3. **The steps on offer.** `allowedActions` asks the same `can()` questions the routes ask, and the engine for the
   record's own facts: SUBMIT_NO_ACTION is offered when the engine lets it pass with the body's three fields given
   (so never for a MAJOR, EXTERNAL_AUDIT, lost-time or fatal, or once not effective NC), VERIFY_EFFECTIVE when it
   passes with the note given (so not before `effectivenessDueOn`), and neither verify step to someone who took a
   maker step since the last reset. VERIFY_NOT_EFFECTIVE stays on offer before `effectivenessDueOn`, as the mock does.

4. **An action added since the reset.** SUBMIT after a VERIFY_NOT_EFFECTIVE or REOPEN needs a DONE action created
   after that step. M16 compares the action's `createdAt` with the step's audit event `at`; both are the database's
   clock, so the order holds whatever the server's clock says.

5. **Effectiveness dates.** The reassign route keeps the mock's rules for `effectivenessDueOn`: it moves once
   PLAN_ACTIONS set it, is never cleared, and is not set in the past. The steps that set it (PLAN_ACTIONS,
   VERIFY_NOT_EFFECTIVE and REOPEN) are held by the engine's guards instead (not past; after today), so those rules
   do not apply to them twice.

6. **How the list pages.** As M16-0005 decision 3: `ids`, unit scope and the other filters run in SQL, 200 rows at a
   time; then M16 applies `q` (the number, the description and the root cause, as the mock does; M3 searches the
   description only), `overdue` (the engine's `nonconformityStatus` over the NCs' OPEN actions, read once for the
   client), the order (newest `reportedOn` first, then number) and its own cursor. `incident` narrows `source` to, or
   away from, INCIDENT and NEAR_MISS in SQL.

7. **A unit move needs the new unit too (closes the #320 audit's Low 2).** A PATCH that moves a risk item or a
   nonconformity to another unit authorizes the write again on the new unit, naming nobody, so the named-person
   exception cannot carry a record into a unit the writer does not cover. The owner check still follows (the owner
   covers the new unit). ISO-8c's later parts do the same for the records they add that have a unit.

8. **Files on a nonconformity.** Its files are written by whoever `isoNc.work` lets act (a client admin, or the owner
   as its owner), so account admins and consultants read but do not add or remove them, as the mock does; they lock
   once the NC is CLOSED or CANCELLED (model §6); and an incident NC's files, like its actions' (ISO-8b), are
   downloaded only by its owner, approver and investigators and by client admins, consultants and account admins.

9. **RAISE.** The checks of a raise are those of an edit from an empty record, so every field is checked once: the
   unit against the system, standards and clauses, the three kinds of people, linked instances (a statutory notice
   is an instance of an act that is not STANDARD on the NC's unit), the incident's time (not after now, and its day
   in the client's time zone not after `reportedOn`, the client's today) and the stored shape. The database numbers
   the NC at the default READ COMMITTED isolation (#280 audit Info 2). ISO-8c part 2 raises a finding's NC through the
   same function, with `fromFinding` for the engine and `auditFindingId` on the RAISE event.

## Consequences

- ISO-8c part 2 reuses `raiseNonconformity`, `ncReach` and `unrecorded` for findings and their NCs.
- `docs/contracts/iso-mock.md` needs no change: the mock's picks for nonconformities hold, except decisions 1 to 3.
