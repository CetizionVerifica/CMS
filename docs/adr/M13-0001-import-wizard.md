# M13-0001. M13 import wizard: one URL per batch, the step from the batch status

Status: accepted (M13, 2026-10-24)

## Context
`MODULES.md` M13 asks for an import wizard (upload, map, review, dry run, commit, resume) on
`/c/{clientId}/import`, built on the import endpoints of `docs/contracts/endpoints.md` §5 as M8 implements them
(ADR M8-0001, M8-0002): the upload goes to a presigned URL, parse runs in the background and returns 202, and the
analysis re-runs on every review decision. The wizard has to survive a reload, a second tab and a person who
leaves and comes back days later.

## Decisions
1. **The batch is the state.** `?batch=<id>` names the import; the page reads the batch and its status picks the
   screen (`batchView` in `import-model.ts`): UPLOADED and MAPPED show the mapping, PARSED and REVIEWED the
   review, DRY_RUN_READY the dry run, COMMITTED the result, CANCELLED and FAILED a closed message. Nothing about
   the wizard lives in the browser, so resuming is opening the link, and the "Earlier imports" table links every
   open batch with "continue". `?step=review` reopens the review from the dry run; `?parsing=1` waits on a parse
   the person just started (the batch is still MAPPED until the background run ends), polling with
   `router.refresh()` every 2 s.
2. **The browser uploads the bytes.** The server action asks for the upload ticket; the browser hashes the file
   (SHA-256, Web Crypto), PUTs it to the presigned URL and calls the confirm action. The file never passes through
   the web server and the URL is never rendered or logged (root rule 6). The demo API stores no bytes, so it
   hands out no URL and the PUT is skipped.
3. **The suggested mapping is saved at upload.** Confirming the upload saves the API's suggested mapping for the
   first sheet, so a batch left on the mapping step shows that mapping when it is reopened. "Read the rows" saves
   the person's mapping (and an optional client template) and starts the parse.
4. **Proposals before changes.** The review shows every group's workbook values next to the proposal (root rule
   5). "Accept every proposal" sends one decision per group with a proposal, in order, because the analysis
   re-runs after each and a later group can change; groups without a proposal still need a decision.
5. **Refusals are sentences.** Server actions return `{ ok: false, message }` for the API's expected refusals
   (IMPORT_STATE, IMPORT_BLOCKED, UNSUPPORTED_FILE, FILE_TOO_LARGE, FORBIDDEN, VALIDATION) and refresh the page,
   so a batch moved on in another tab shows where it is now. A refused commit or cancel closes its dialog and
   shows the reason on the page. Anything else is thrown to the error boundary.

## Consequences
- Every step change is a server round trip; the wizard has no client cache to fall out of date.
- A batch whose background parse is lost (M8-0001 §3) stays MAPPED; the waiting screen links back to the mapping,
  where "Read the rows" starts it again.
- The e2e runs against the M0 mock, which answers every upload as the sample register.
