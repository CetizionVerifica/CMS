# @canopy/contracts

Owned by **M0 · Contracts & domain spec**. The shared shapes every module builds against. Contract version
`CONTRACTS_VERSION` (`src/version.ts`); history in `docs/contracts/CHANGELOG.md`.

```ts
import { ComplianceInstance, LocalDate, type EngineApi } from '@canopy/contracts';

const instance = ComplianceInstance.parse(row); // throws on a shape or consistency error
```

| File | What |
|---|---|
| `src/primitives.ts` | `Id`, `LocalDate` (branded, real calendar dates only), `Instant` (UTC `Z`), `MonthDay`, `FyLabel`, text and code types, `baseShape` / `versionedShape` |
| `src/enums.ts` | Every enum in `docs/contracts/domain-model.md` §2, plus `IMPORT_ISSUE_SEVERITY`, `FIRM_ROLES`, `CLIENT_ROLES` |
| `src/errors.ts` | `ErrorCode`, `ERROR_HTTP_STATUS`, `ErrorEnvelope` |
| `src/defaults.ts` | `DEFAULT_FIRM_SETTINGS`, `DEFAULT_CLIENT_SETTINGS` (PLAN.md §7) |
| `src/schemas/*` | Entity schemas: tenancy, library (incl. `RecurrenceRule`), work, import, scores, request context |
| `src/engine-api.ts` | Signatures M4 implements (`EngineApi`) |

Each schema exports a Zod value and a type of the same name. Schemas check shape and consistency only; no due-date,
status or score maths lives here (that is `packages/engine`).

Change a contract through M0 (`docs/contracts/README.md`). Do not edit this package from another module.

Coming in later M0 PRs: request/response schemas and the OpenAPI 3.1 spec, typed fixtures, the mock API server.
