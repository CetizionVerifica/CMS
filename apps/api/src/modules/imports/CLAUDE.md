# apps/api/src/modules/imports: import API (M8)

`apps/api/CLAUDE.md`, `packages/importer/CLAUDE.md` and the root `CLAUDE.md` apply. Decisions: `docs/adr/M8-0001-import-api.md`
(upload, parse, review) and `docs/adr/M8-0002-import-commit.md` (dry run, commit, periods, firm templates).

- `steps.ts`: the steps of endpoints.md §5 over an `ImportStore`. Checks permissions (`import.*`), the client and
  the step order (`409 IMPORT_STATE`). No database code here.
- `service.ts`: `repositoryStore(db)`, the `ImportStore` on the M3 repositories. The only database code; covered by
  `pnpm --filter @canopy/api test:db` (`imports.db.test.ts`). `existingState` loads the client's stored data under
  the importer's natural keys; `commit` writes a plan in the caller's transaction with an `AuditEvent` per change.
- Firm-wide mapping templates (`clientId: null`) need FIRM_ADMIN; commit needs only `import.commit`.
- Plan limits: commit refuses with 403 PLAN_LIMIT_REACHED when the companies or units it would create pass the plan's
  limit (`ImportTx.planAllowance`, under the account's usage lock). The background half checks again in its own
  transaction and fails the batch with `failureCode: 'PLAN_LIMIT_REACHED'` if the account filled up meanwhile.
- ISO standard acts (ISO-16, docs/iso/catalogue.md §2): an import matches and creates STATUTE acts only. `loadClient`
  leaves STANDARD acts, and the obligations under them, out of what the analysis and the commit know, so a register
  Act named like an ISO standard gets its own STATUTE act and never touches the ISO catalogue copy.
- `files.ts`: upload storage. `s3ImportFiles` for S3-compatible storage, `MemoryImportFiles` for tests.
- `routes.ts`: thin routes, parsed with the contract schemas.
- `seed.ts`: the `pnpm db:seed` hook (`canopy.seed` in apps/api/package.json). It runs these steps over the anonymised
  sample register for seed firm A's consultant with the recommended profile; `seed.db.test.ts` checks the golden counts
  and that a second seed changes nothing. Logs counts only.
- Tests: `imports.test.ts` walks every step and role on `testing/memory-store.ts`.
- Rows, issues and workbooks hold employee names: never log them, never put them in error details.
