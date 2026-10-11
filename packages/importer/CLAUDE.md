# packages/importer: Excel register import

Turns a client's existing register (like the sample EY grid export) into library, assignments and instances.
Root `CLAUDE.md` applies. Field mapping and data quirks: `docs/requirements/excel-analysis.md`.

## Flow
1. **Upload**: `.xlsx` or `.csv`, max 20 MB, first non-empty sheet by default (user can pick).
2. **Map columns**: auto-match headers to Canopy fields using the known-headers table (the 19 sample headers map 1:1); user confirms. Save the mapping as a reusable template per client.
3. **Parse and clean** into an `ImportBatch` with one `ImportRow` per source row, each holding raw, mapped and issues.
4. **Review**: show proposed merges and issues grouped by type with counts; user accepts or edits each group.
5. **Dry run**: report exactly what will be created or updated (obligations, acts, people, assignments, instances). Nothing is written yet.
6. **Commit** in one transaction per batch, writing `AuditEvent`s with `action = IMPORT`. Re-running the same file is idempotent.

## Cleaning rules (propose, never apply silently)
- Trim and collapse whitespace everywhere. Treat `NA`, `N/A`, `-`, empty as null for Form and Log Sheet.
- **People**: match case-insensitively on normalised name ("surajit dasgupta" = "Surajit Dasgupta"); display in title case; flag near-matches (edit distance ≤ 2) for review, do not auto-merge them. Email is unknown in the sheet, so people are created as unclaimed until invited.
- **Enums**: criticality case-insensitive ("HIGH" → High); unknown value → issue, row kept as TO_REVIEW.
- **Aliases**: departments ("HR" ↔ "Human Resources"), categories ("Procedural Requirement(s)"), Acts (spelling and year variants). Suggest merges; store accepted ones in the aliases columns so the next import is automatic.
- **Hierarchy paths**: split "Group/ Company/ Unit" and "Country/ State/ City" on `/`, trim each part.
- **Status**: Complied → APPROVED with `completed_on = Activity Date`; Pending → OPEN; Not Applicable → NOT_APPLICABLE with `na_reason = Owner Comments`. Complied without Activity Date → issue (1 such row in the sample).
- **Obligation identity**: group rows by the source ID (`EY Compliance ID` or mapped equivalent); if no ID column, by (Act, Title, Unit). Conflicting obligation-level values within a group (e.g. two owners) → keep the first on the obligation, keep per-row values on instances, list as info.
- **Recurrence inference**: from each obligation's due dates infer a `RecurrenceRule` via the engine (`inferRule`); low confidence → mark rule TO_REVIEW, still import the instances as given.
- File names inside Form/Log Sheet ("Schedule.docx") become template placeholders flagged "file not attached".

## How the package is built
- Pure functions, no I/O: `readWorkbook` (bytes → sheets), `suggestMapping` / `validateMapping`,
  `analyseImport` (rows, issues and an `ImportPlan` keyed by natural keys), `dryRun`, `stateAfterCommit`.
  The API module (`apps/api/src/modules/imports`) stores batches and calls these; the commit writes the plan
  through the M3 repositories.
- `analyseImport` takes the engine's `inferRule` as an argument (`EngineApi['inferRule']`), so no recurrence
  maths lives here. An existing obligation keeps its library rule and is not re-inferred.
- Decisions are inputs: re-run `analyseImport` with the stored decisions after every review change. A PENDING
  WARNING is previewed as its proposal (so duplicate periods appear while aliases are still pending); INFO
  issues are always accepted; ERROR issues block their rows until edited (value supplied) or rejected (row
  skipped). `checkDecision` says which decisions each issue type allows.
- Issue `groupKey`s are hashes, so names never reach URLs or request logs.
- A Pending row with an Activity Date is an `UNKNOWN_ENUM` issue on `status` (ERROR, no proposal): the person
  edits the status ("Pending" keeps the row open and moves the date into an IMPORT comment, "Complied" keeps it)
  or skips the row. Dates outside 1950 to 2100 are `INVALID_DATE` (a year typed as a number is not a serial).
- Every source row ends as an instance, SKIPPED or ERROR: a row that cannot be planned is never dropped.
- Analysis stays near linear (20,000 rows in well under a second locally; `test/scale.test.ts`).
- For the API and commit PRs: refuse commit unless `isReviewed(issues)`; cap the inflated xlsx size or parse in
  a worker, because the 20 MB limit is on compressed bytes.
- The golden fixture is pseudonymised (`fixtures/README.md`, ADR 0001).

## Tests
- Golden test on `fixtures/sample-register.xlsx` asserts the counts in excel-analysis.md §5.
- Idempotency: import twice, second run creates nothing and reports every instance unchanged (422 under the recommended profile, see docs/contracts/fixtures.md).
- Round trip: export the register (apps/api report) and re-import → no changes.
- Fuzz: shuffled columns, extra columns, missing optional columns, dates as text and as Excel serials.
- Never log raw rows outside the batch tables; they contain employee names.
