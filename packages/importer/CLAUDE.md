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

## Tests
- Golden test on `fixtures/sample-register.xlsx` asserts the counts in excel-analysis.md §5.
- Idempotency: import twice, second run creates nothing and reports every instance unchanged (422 under the recommended profile, see docs/contracts/fixtures.md).
- Round trip: export the register (apps/api report) and re-import → no changes.
- Fuzz: shuffled columns, extra columns, missing optional columns, dates as text and as Excel serials.
- Never log raw rows outside the batch tables; they contain employee names.
