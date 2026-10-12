# apps/api/src/modules/imports: import API (M8)

`apps/api/CLAUDE.md`, `packages/importer/CLAUDE.md` and the root `CLAUDE.md` apply. Decisions: `docs/adr/M8-0001-import-api.md`.

- `steps.ts`: the steps of endpoints.md §5 over an `ImportStore`. Checks permissions (`import.*`), the client and
  the step order (`409 IMPORT_STATE`). No database code here.
- `service.ts`: `repositoryStore(db)`, the `ImportStore` on the M3 repositories. The only database code; covered by
  `pnpm --filter @canopy/api test:db` (`imports.db.test.ts`).
- `files.ts`: upload storage. `s3ImportFiles` for S3-compatible storage, `MemoryImportFiles` for tests.
- `routes.ts`: thin routes, parsed with the contract schemas.
- Tests: `imports.test.ts` walks every step and role on `testing/memory-store.ts`.
- Rows, issues and workbooks hold employee names: never log them, never put them in error details.
