# M10-0002: The client archive export (CLIENT_ARCHIVE_ZIP)

Status: accepted (M10, company accounts) · 2026-10-24

## Context
Company accounts (M15, ADR M15-0001) let an account admin take their data out before an account is deleted: the
account sits in PENDING_DELETION for 30 days and the M5 plugin signs admins in only to export
(`config.whilePendingDeletion`). Contracts 1.5.2 adds the export kind `CLIENT_ARCHIVE_ZIP`, and migration 0026 adds
it to the database enum. Nothing built the file yet.

## Decisions
1. **One archive per client, through the existing export routes.** `POST /exports` with
   `kind: CLIENT_ARCHIVE_ZIP` and a `clientId`. A firm-wide archive would need `export_job.client_id` to be nullable;
   the account page asks once per client instead.
2. **Account admins only.** Any other role gets 403 `FORBIDDEN` (`export.create`). The archive holds every unit's
   evidence, so unit scope cannot apply. Filters, `unitId` and `fy` are refused with 400 `VALIDATION` on `kind`:
   the archive is always the whole client.
3. **Support sessions are refused.** An operator signed in on a support grant gets 403: the grant lets support look,
   not take a copy of the client's files.
4. **Open while PENDING_DELETION.** The create, get and download export routes set `whilePendingDeletion: true`, so
   every export kind works during the grace period. Nothing else does.
5. **Contents.** `register.xlsx` (the REGISTER_XLSX build over all dates and units, so it re-imports), then
   `evidence/<due date> <obligation> <unit>/<file name>`, then `evidence/index.csv` (item, unit, due date, upload
   time, size, SHA-256) and `README.txt`. File names are made safe for any system; a repeated name gets a `2 `
   prefix. CSV cells that would run as formulas are quoted with `'`.
6. **Clean evidence only.** A file whose scan is PENDING, INFECTED or FAILED stays out and the README counts it.
   Archived evidence is left out, as in the vault. A file missing from storage is counted in the README, not fatal.
7. **Streamed.** Evidence is read one file at a time into a zip stream, and the stream goes to S3 in 8 MiB parts
   (multipart upload, aborted on error; a single PUT when the whole file fits in one part). Memory stays flat
   however large the client's evidence is. No file names or contents are logged (root rule 6).

## Dependencies
- `archiver` (runtime): writes the zip stream. It is already in the tree through `exceljs`, so it adds no new code
  to the install; it is now a direct dependency at the same major version.
- `@types/archiver` (dev): its types.
- `jszip` (dev): reads the archive back in tests. Also already in the tree through `exceljs`.
- No `@aws-sdk/lib-storage`: the multipart upload is about 40 lines over the client we already use.
