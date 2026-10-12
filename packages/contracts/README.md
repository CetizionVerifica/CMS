# @canopy/contracts

Owned by **M0 · Contracts & domain spec**. The shared shapes every module builds against. Contract version
`CONTRACTS_VERSION` (`src/version.ts`); history in `docs/contracts/CHANGELOG.md`.

```ts
import { ComplianceInstance, ENDPOINTS, tolerant } from '@canopy/contracts';

const instance = ComplianceInstance.parse(row); // throws on a shape or consistency error

// Server: validate input with the endpoint's schemas.
const body = ENDPOINTS.submitInstance.body.parse(request.body);
// Client: parse responses tolerantly (unknown fields and enum values are allowed).
const detail = tolerant(ENDPOINTS.getInstance.response).parse(await response.json());
```

| File | What |
|---|---|
| `src/primitives.ts` | `Id`, `LocalDate` (branded, real calendar dates only), `Instant` (UTC `Z`), `MonthDay`, `FyLabel`, text and code types, `baseShape` / `versionedShape` |
| `src/enums.ts` | Every enum in `docs/contracts/domain-model.md` §2, plus `IMPORT_ISSUE_SEVERITY`, `FIRM_ROLES`, `CLIENT_ROLES` |
| `src/errors.ts` | `ErrorCode`, `ERROR_HTTP_STATUS`, `ErrorEnvelope` |
| `src/defaults.ts` | `DEFAULT_FIRM_SETTINGS`, `DEFAULT_CLIENT_SETTINGS` (PLAN.md §7) |
| `src/schemas/*` | Entity schemas: tenancy, library (incl. `RecurrenceRule`), work, import, scores, request context |
| `src/engine-api.ts` | Signatures M4 implements (`EngineApi`) |
| `src/api/endpoints.ts` | `ENDPOINTS`: every endpoint with method, path, `can()` actions, role access and schemas |
| `src/api/{auth,entities,workflow,imports,dashboards}.ts` | Request bodies, query schemas and response shapes per provider module |
| `src/api/common.ts` | Pagination, sorting, comma lists, `page()`, `list()`, bulk results, signed URLs |
| `src/api/tolerant.ts` | `tolerant(schema)`: the schema clients parse responses with |
| `src/api/error-details.ts` | `ERROR_DETAILS` per error code and `ApiErrorResponse` |
| `src/api/openapi.ts` | `buildOpenApi()`; `pnpm --filter @canopy/contracts openapi` writes `docs/contracts/openapi.json` |

Each schema exports a Zod value and a type of the same name. Schemas check shape and consistency only; no due-date,
status or score maths lives here (that is `packages/engine`).

Change a contract through M0 (`docs/contracts/README.md`). Do not edit this package from another module.

After changing a schema or endpoint, run `pnpm --filter @canopy/contracts openapi`; a test fails while
`docs/contracts/openapi.json` is stale.

Coming in later M0 PRs: typed fixtures and the mock API server.
