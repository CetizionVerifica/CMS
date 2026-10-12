# M12-0001. Register: URL state, search parameter and saved views

Status: accepted (M12 PR 1, 2026-10-12)

## Context
The register keeps its filters, sort, search and period in the URL (apps/web/CLAUDE.md "Data and state"), and
api-conventions.md §3 says saved views, dashboard links and exports share one filter language: the register query.
Two things get in the way: the shell's period picker already writes `q` (quarter) and `m` (month) into the same URL
(lib/period.ts), and the contracts have no endpoint for saved views.

## Decisions
1. **URL names are the API's names.** Filters and sort use `RegisterQuery`'s keys and value formats (comma lists,
   `-field` for descending), so a register URL can be pasted into the API, an export, or a saved view unchanged.
2. **Search is `search` in the URL.** `q` belongs to the period picker, so free text lives in `search` and is sent to
   the API as `q`. This is the one renamed key.
3. **Bad values degrade, not fail.** Each URL value is checked against its contract schema on its own; a value the
   contract would reject is dropped (no filter), never an error page. The built query is then checked against
   `RegisterQuery` as a whole.
4. **Period.** The URL's `fy` is sent as the register's `fy`. An explicit due-date range wins over the FY, because the
   contract forbids sending both. The period's quarter or month does **not** narrow the register: the contract has no
   quarter or month filter, and working out a quarter's dates from the client's FY start would put period logic in
   the web app. Requested from M0 as an additive `RegisterQuery.quarter`/`month` (or a `period` key); until then the
   register shows the whole FY and the due-date filter narrows it.
5. **Saved views live in this browser's localStorage**, keyed by person and client
   (`pp.register.views.<personId>.<clientId>`). A view stores only the register part of the URL (filters, search,
   sort; never the period, rows or names), in a fixed key order so "edited" is a string comparison. Storage that is
   blocked or full shows a warning toast and the register keeps working. A view endpoint can replace this later
   without changing the URL format.
6. **Default view.** A person can mark one view as theirs; the register opens on it only when the URL carries no
   register state, so a shared or dashboard link always shows what it says.
7. **Sent back.** The engine's derived status has no "sent back" (it is open work), but the status language does
   (packages/ui/CLAUDE.md), so a row in workflow state `SENT_BACK` shows the Sent back pill. This is display only;
   filtering still uses the engine status.
8. **Sorting is on the server** (`manualSorting`); only columns that are `REGISTER_SORT_FIELDS` can be sorted.

## Consequences
- Views do not follow a person to another browser until a saved-view endpoint exists.
- Until decision 4's contract change lands, choosing Q3 in the period picker does not narrow the register.
