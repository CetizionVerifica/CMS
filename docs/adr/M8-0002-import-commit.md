# M8-0002. M8 import commit: periods, people, audit and who writes firm templates

Status: accepted (M8, 2026-10-12)

## Context
The commit step (`docs/contracts/endpoints.md` §5, steps 5 and 6) writes a reviewed `ImportPlan` through the M3
repositories. The plan holds natural keys, due dates and person names; the database needs periods, ids and an
audit trail. M10's round trip (export the register, re-import it) must change nothing. The audit of #44 also asked
who may write firm-wide mapping templates.

## Decisions
1. **Dry run, then commit, in order.** `POST /imports/{id}/dry-run` needs REVIEWED or DRY_RUN_READY and stores the
   report (DRY_RUN_READY). `POST /imports/{id}/commit` needs DRY_RUN_READY, so a batch with a PENDING issue can never
   commit (a review decision after the dry run puts the batch back to REVIEWED). It is refused with
   `422 IMPORT_BLOCKED` (`blockingIssueIds`) while a PENDING issue or an ERROR row remains. It returns 202 with the
   batch COMMITTING; calling it again returns the batch and starts nothing while that run is going.
2. **One transaction, off-request.** The commit re-runs the analysis over the stored rows and decisions, loads the
   client's existing library, people, assignments and instances, writes the plan, sets each row's outcome and
   target instance, and moves the batch to COMMITTED, all in one `withTenant` transaction. A failure rolls it all
   back and sets FAILED (`failureCode: INTERNAL`). As with parse (M8-0001), a restart loses an in-flight commit (rolled
   back with its transaction) and the batch stays COMMITTING; calling commit again starts it over. The M9 job runner
   is the later home for it.
3. **Periods come from the engine.** A new instance takes the period the engine generates for its obligation's rule
   whose due date equals the instance's due date, so the nightly generator (unique on `(assignment_id,
   period_start)`) finds it and does not add a duplicate. When no generated period has that due date (an irregular
   register date, a TO_REVIEW rule) or that period is already taken, the period is the due date itself.
4. **Re-import compares field by field** (`instanceChange`, packages/importer): comments are append-only and match
   in order; a SUBMITTED or SENT_BACK instance whose row still says Pending with no Activity Date is unchanged and is
   never moved back to OPEN. A changed instance keeps its id and gets one `update` (version + 1).
5. **People are created UNCLAIMED, without memberships.** The register has no emails. They are matched by
   `nameNormalized` within the client's people and are invited later by a client or firm admin.
6. **Audit actions.** Every created or changed entity writes an `AuditEvent` with `action = IMPORT` (before and after
   hold the changed fields only, never names from rows) in the commit's transaction; an accepted alias is
   `MERGE_ALIAS` on the act, category or department. Appended comments are IMPORT comments with no author, plus
   one IMPORT event `{ commentsAdded }` per instance. The actor is the person who called commit.
7. **Firm templates are FIRM_ADMIN only.** A consultant can run every import step for their clients, including
   commit, and save client templates, but creating, renaming or deleting a firm-wide template (`clientId: null`)
   and saving a mapping as one needs FIRM_ADMIN (`403 FORBIDDEN`), because firm templates apply to every client.

## Consequences
- ExcelJS holds the whole workbook in memory while parsing (up to the 250 MB inflated limit in M8-0001); parse runs
  off-request but in the API process, so a large file costs API memory until the run ends.
- The `inferRule` cache (M8-0001) lives in the process and is per instance of the API; it is a speed-up only.
- `pnpm db:seed` loading through the importer is M3's (packages/db) to wire; `repositoryStore` and the importer's
  pure functions are what it calls.
