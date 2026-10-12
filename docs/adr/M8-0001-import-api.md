# M8-0001. M8 import API: upload tickets, background parse and re-analysis on review

Status: accepted (M8, 2026-10-12)

## Context
`docs/contracts/endpoints.md` §5 defines the import steps. Three things it leaves to M8: how a batch id handed
out at step 1 becomes a batch only once the bytes are uploaded, how parse runs "async", and what happens to the
stored issues when a review decision changes the analysis.

## Decisions
1. **Upload ticket.** `POST /clients/{clientId}/imports` generates the batch id (`uuidv7()`, never from the
   client) and presigns a PUT to `imports/{firmId}/{batchId}` for 5 minutes. The client id, the uploader and the
   file name travel as S3 metadata in signed headers, so they cannot be changed and need no table.
   `POST /imports/{id}/uploaded` reads the object under the session's firm, checks the SHA-256, and creates the
   batch under the ticket's id. Another firm's session looks under its own prefix and finds nothing (404).
2. **Only .xlsx.** The contract's `ImportCreateBody` accepts `.xlsx` and `.xls`; the importer reads `.xlsx` (and
   CSV, which the contract does not allow). `.xls` is refused with `415 UNSUPPORTED_FILE` (`allowed: [".xlsx"]`).
   An `.xlsx` whose central directory declares more than 250 MB uncompressed is refused with
   `413 FILE_TOO_LARGE` before ExcelJS inflates it (the 20 MB limit is on compressed bytes).
3. **Parse in the background, in process.** `POST /imports/{id}/parse` returns 202 with the batch still MAPPED
   and starts one run per batch. The run stores rows and issues and moves the batch to PARSED (REVIEWED when
   nothing needs a decision) in one transaction, and only if the batch is unchanged since the call (same
   version, still MAPPED), so a cancel or re-mapping in between wins. A failure sets FAILED with the error code
   in `failureCode`. A restart loses an in-flight run; the batch stays MAPPED and parse can be called again.
   Moving this to the M9 job runner is a later option.
4. **Re-analysis on every decision.** After `PATCH /imports/{id}/issues/{groupKey}` the analysis re-runs over the
   stored raw rows with every stored decision. A decision can add or remove other issues (on the sample,
   rejecting every warning removes 3 groups and adds 2). Stored groups whose rows, values or proposal changed,
   or that are no longer raised, are deleted (`importIssues.removeGroups`); new ones are added with the decision
   in force; rows are relinked. The batch is REVIEWED when no issue is PENDING, and a stored dry run is cleared.
   `inferRule` results are cached across runs, so a review click does not pay the engine cost again.
5. **One store interface.** `steps.ts` holds the step logic over an `ImportStore` interface. `service.ts`
   implements it on the M3 repositories (the module's only database code, covered by `pnpm test:db`), and the
   route tests use an in-memory store, so every step and role is tested quickly.

## Consequences
- Existing assignments and instances are not loaded yet, so dry run and commit (with M10's re-import rules) come
  in the next M8 PR.
- `main.ts` does not mount the import routes yet: `buildServer({ imports })` needs the database, storage and
  the engine, which the app's composition root will pass once it exists.
