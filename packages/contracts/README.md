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
| `src/enums.ts` | Every enum in `docs/contracts/domain-model.md` §2, plus `IMPORT_ISSUE_SEVERITY`, `FIRM_ROLES`, `CLIENT_ROLES`, and the staged ISO constants `ISO_ENTITY_TYPES`, `ISO_NOTIFICATION_KINDS`, `ISO_EXPORT_KINDS` (domain-model.md §10) |
| `src/errors.ts` | `ErrorCode`, `ERROR_HTTP_STATUS`, `ErrorEnvelope` |
| `src/defaults.ts` | `DEFAULT_FIRM_SETTINGS`, `DEFAULT_CLIENT_SETTINGS` (PLAN.md §7), `DEFAULT_ISO_RISK_RULE`, the ISO reminder shapes and `ISO_REMINDER_SCHEDULE` |
| `src/schemas/*` | Entity schemas: tenancy, library (incl. `RecurrenceRule`), work, import, scores, request context, accounts (plans, support grants, operator audit); `iso.ts` (the ISO catalogue, every ISO record, the machines' enums, `IsoFile`) and `iso-results.ts` (what the ISO engine returns) |
| `src/engine-api.ts` | Signatures M4 implements: `EngineApi`, and `IsoEngineApi` beside it |
| `src/api/endpoints.ts` | `ENDPOINTS`: every endpoint with method, path, `can()` actions, role access and schemas (the ISO routes spread in from `iso-endpoints.ts`); `PLATFORM_ENDPOINTS`: the operator API under `/api/platform/v1` |
| `src/api/endpoint-def.ts` | The `Endpoint` shape and the `endpoint()` builder both endpoint tables use, with `Endpoint.feature` (an add-on's routes; `x-canopy-feature` in OpenAPI) |
| `src/api/iso-endpoints.ts` | `ISO_ENDPOINTS`: the 117 M16 routes under `/clients/{clientId}/iso/`, all gated on `isoManagement` |
| `src/api/can.ts` | `can()`: the stub policy from the `ENDPOINTS` role matrix, until M5's lands |
| `src/api/{auth,entities,workflow,imports,dashboards,iso}.ts` | Request bodies, query schemas and response shapes per provider module (`iso.ts`: the ISO bodies, queries, views, `IsoOverview` and `ISO_EXPORT_FILTERS`) |
| `src/api/common.ts` | Pagination, sorting, comma lists, `page()`, `list()`, bulk results, signed URLs |
| `src/api/tolerant.ts` | `tolerant(schema)`: the schema clients parse responses with |
| `src/api/error-details.ts` | `ERROR_DETAILS` per error code and `ApiErrorResponse` |
| `src/api/openapi.ts` | `buildOpenApi()` and `buildPlatformOpenApi()`; `pnpm --filter @canopy/contracts openapi` writes `docs/contracts/openapi.json` and `openapi.platform.json` |
| `src/fixtures/schema.ts` | `FixtureSet`, `DueDatesFixture`, `ExpectedFixture`, `IsoCatalogueFixture`, `IsoFixtureSet` |
| `src/fixtures/index.ts` | Node entry `@canopy/contracts/fixtures`: `fixtureId`, `uuidV5`, `loadFixtureSet`, `loadDueDates`, `loadExpected`, and for ISO `loadIsoCatalogue`, `loadIsoFixtureSet`, `isoCatalogueRows`, `isoCatalogueId`, `isoClauseId` |
| `fixtures/*.json` | Generated fixtures (`docs/contracts/fixtures.md`); do not edit by hand |
| `scripts/fixtures/*` | The generator: a small xlsx reader, the firm A and firm B builders, the ISO catalogue (`iso-catalogue.ts`) and firm B's ISO data (`firm-b-iso.ts`) |
| `src/mock/*` | Node entry `@canopy/contracts/mock`: `createMockServer`, `HANDLERS`, the in-memory `MockStore`, and the test-double status, score and period helpers the fixtures also use; `mock/handlers/iso/*` serve the ISO routes, with shared checks in `mock/iso/common.ts` and the ISO test double in `mock/iso/derive.ts` |

Each schema exports a Zod value and a type of the same name. Schemas check shape and consistency only; no due-date,
status or score maths lives here (that is `packages/engine`).

Change a contract through M0 (`docs/contracts/README.md`). Do not edit this package from another module.

After changing a schema or endpoint, run `pnpm --filter @canopy/contracts openapi`; a test fails while
`docs/contracts/openapi.json` is stale.

Fixtures, in a test, seed or mock:

```ts
import { fixtureId, loadExpected, loadFixtureSet } from '@canopy/contracts/fixtures';

const firmA = loadFixtureSet('firm-a.sample'); // parsed with the strict entity schemas
const expected = loadExpected(); // golden counts and scores
const tds = fixtureId('obligation:TAX-CL-033-6067-60218'); // the same id in every module
```

Regenerate them with `pnpm --filter @canopy/contracts fixtures <path to sample-register.xlsx>`. Without the xlsx
(it lands with M8 at `packages/importer/fixtures/sample-register.xlsx`) only firm B, the ISO catalogue and firm B's
ISO data are rebuilt. A test fails if firm B, the catalogue or firm B's ISO data drifts from its generator, or firm A
from the documented counts.

```ts
import { isoCatalogueRows, isoClauseId, loadIsoFixtureSet } from '@canopy/contracts/fixtures';

const iso = loadIsoFixtureSet(); // Northwind Foods Group's ISO records (firm B)
const copy = isoCatalogueRows(iso.firmId, iso.catalogueCopiedAt); // the account's catalogue copy
const calibration = isoClauseId(iso.firmId, 'ISO_9001', '7.1.5');
```

The mock API, for frontends and consumer contract tests:

```sh
pnpm --filter @canopy/contracts mock                 # http://localhost:4010/api/v1
MOCK_TODAY=2024-11-15 pnpm --filter @canopy/contracts mock
```

```ts
import { createMockServer } from '@canopy/contracts/mock';

const app = createMockServer({ today: '2024-11-15' });
const res = await app.inject({
  method: 'GET',
  url: '/api/v1/me',
  headers: { 'x-mock-person': 'meera.kulkarni@second-ledger.example' },
});
```

Sign in with any password (any six digits for MFA), or send `X-Mock-Person` with a person id or email.
`GET /__mock/people` lists who can sign in, `GET /__mock/outbox` shows magic links and invites, and
`POST /__mock/reset` restores the fixtures. Firm B has the ISO add-on (`isoManagement`) with its catalogue copy
recorded, and firm A does not. `PUT /__mock/firms/{firmId}/features` with `{ "features": [...] }` switches add-ons the
way the operator console does; turning `isoManagement` on copies the ISO catalogue, unless the body also says
`"isoCatalogueCopied": false`, which leaves a never-copied account answering `409 FEATURE_NOT_READY` on ISO routes.
The `X-Mock-Features` header (comma-separated flags, empty for none) replaces the account's features for one request,
so a test or the web mock can play a user without an add-on. Behaviour the contract leaves open is in
`docs/contracts/README.md` decisions 33-41 and 49.
