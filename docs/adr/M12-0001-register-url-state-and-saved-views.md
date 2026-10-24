# M12-0001. Register: URL state, search parameter and saved views

Status: accepted (M12 PR 1, 2026-10-12; decisions 4 and 5 revised and 9 to 11 added in M12 PR 2)

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
4. **Period.** The register shows the URL's period, or the client's current quarter when the URL has none (what the
   period picker displays). lib/period.ts's `periodApiQuery` turns it into API values: a whole FY is sent as `fy`, a
   quarter or month as `dueFrom`/`dueTo`. An explicit due-date filter wins over the period, because the contract takes
   one or the other and the person chose it. The web app does only calendar arithmetic; which instances fall in the
   range is the API's decision.
5. **Saved views live in this browser's localStorage**, keyed by person and client
   (`pp.register.views.<personId>.<clientId>`). A view stores the register part of the URL (filters, search, sort;
   never the period, rows or names), in a fixed key order, plus the grid layout (visible columns in order, and
   density), as the Save dialog promises. It is "edited" while either differs. Views saved before the layout was kept
   open with the default layout. Storage that is blocked or full shows a warning toast and the register keeps
   working. A view endpoint can replace this later without changing the URL format.
6. **Default view.** A person can mark one view as theirs; the register opens on it only when the URL carries no
   register state, so a shared or dashboard link always shows what it says.
7. **Sent back.** The engine's derived status has no "sent back" (it is open work), but the status language does
   (packages/ui/CLAUDE.md), so a row in workflow state `SENT_BACK` shows the Sent back pill. This is display only;
   filtering still uses the engine status.
8. **Sorting is on the server** (`manualSorting`); only columns that are `REGISTER_SORT_FIELDS` can be sorted.
9. **Rows load a page at a time.** The server renders the first 200 rows (the API's page limit) with the matching
   count; "Show more" loads the next page through a Server Action with the same query. A new URL starts again from
   its first page. The grid stays virtualised however many pages are loaded.
10. **Bulk approve sends at most 200 items per request**, each with the version the person saw, so a row changed
    since then is refused (`STALE_VERSION`) rather than approved blind. "Select all N" first lists every matching row
    in workflow state `SUBMITTED`, page by page with its current version, then asks "Approve N instances?". Confirming
    sends exactly that list: a row the page has loaded keeps the version the person saw, any other row the version
    just listed, so nothing that changes after the person looked or after they were asked is approved unseen. One
    toast says how many were approved and why any were not. (Revised after #88's audit: the first version approved
    whatever was waiting when the request ran, with no confirmation.) Selected rows are confirmed the same way, with
    "Approve N instances?" naming exactly the selection. One bulk approve takes at most 2,000 rows
    (`MAX_APPROVE_AT_ONCE`); with more the page says so and asks the person to narrow the filters, because listing
    and approving 10,000 rows in one Server Action can outrun a request timeout. Larger approvals, if ever needed,
    belong in a job.
11. **Export** starts a `REGISTER_XLSX` export with the register's API query as its filters, so the file matches the
    view, polls it, and opens the 5-minute download link when it is ready. The link is never logged.

## Consequences
- Views do not follow a person to another browser until a saved-view endpoint exists.
- An explicit due-date filter outside the selected quarter shows rows outside that quarter (decision 4).
