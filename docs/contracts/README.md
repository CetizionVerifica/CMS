# Canopy contracts v1 (module M0)

The shared shapes every module builds against. These files describe them; the code in `packages/contracts` is the
source of truth wherever it exists. Shipped in code so far: domain types, enums, entity Zod schemas, error codes, request/response
schemas for every endpoint with role permissions (`packages/contracts/src/api`) and the generated OpenAPI 3.1 spec
([openapi.json](openapi.json)). Still spec only, coming in later M0 PRs: typed JSON fixtures and the mock server.

| File | What it fixes | Main readers |
|---|---|---|
| [domain-model.md](domain-model.md) | Primitives, enums, entities, recurrence rule shape, state machine, import model, score types, `can()` signature | everyone |
| [api-conventions.md](api-conventions.md) | Paths, auth, concurrency, pagination, filters, error envelope and codes, files, versioning | M5-M13 |
| [endpoints.md](endpoints.md) | Every endpoint per provider module with role permissions | M5, M6, M7, M8, M10 (provide), M11-M13 (consume) |
| [openapi.json](openapi.json) | OpenAPI 3.1, generated from the endpoint table in code; do not edit | M5-M13, the mock server |
| [events.md](events.md) | Domain event envelope and catalogue with payloads | M9, M10 and every producer |
| [fixtures.md](fixtures.md) | Fixture files, golden counts and scores recomputed from the sample, firm B spec | M3, M4, M8, M10, M12-M14 |
| [CHANGELOG.md](CHANGELOG.md) | Contract versions | everyone |

## Status
Version `1.1.0` (`CONTRACTS_VERSION` in `packages/contracts/src/version.ts`). The domain model in §1-8 of
[domain-model.md](domain-model.md) is published as v1 so wave 1 (M3, M4, M8, M11) can build against it. Each consumer
module owner still reviews its part (MODULES.md M0 acceptance); review findings ship as additive changes or, if breaking,
with sign-off per "How to change a contract".

## How to change a contract
1. The module that needs a change asks M0 through the coordinator, naming the file, field or endpoint and why.
2. M0 updates the file, bumps the version, adds a CHANGELOG line and announces it.
3. Additive changes (new optional field, new endpoint, new enum value) ship at once. Breaking changes need sign-off from every module that uses the contract.

## Decisions M0 took by default (change if wrong)
1. Error codes are more specific than `apps/api/CLAUDE.md`: `CONFLICT` is split into `STALE_VERSION`, `DUPLICATE` and `IMPORT_STATE`, and 422 codes name the rule broken.
2. A client admin can approve or send back as a delegate (audited `delegated: true`); only the instance owner can submit.
3. Import is for firm admins and consultants only; client admins cannot import in v1.
4. Assignment-level NOT_APPLICABLE stops future generation only; existing instances still go through the per-instance NA approval.
5. Golden counts use two import profiles (`raw` 424 instances, `recommended` 422) because two Excel rows become duplicates once "HR" and "Human Resources" are merged.
6. JSON fixtures pseudonymise the sample's employee names; the xlsx golden file is unchanged.
7. Events go through a transactional outbox on pg-boss; consumers dedupe on event id.
8. Entity schemas are strict (unknown keys rejected, enums closed, enum-keyed records exhaustive) so fixtures, seeds and
   server-side writes cannot carry typos. That is deliberately stricter than api-conventions.md §7, which lets the API
   add fields and enum values without a version bump. Clients must not parse responses with these entity schemas: they parse with
   `tolerant(schema)`, which accepts unknown fields, unknown enum values (shown as "Unknown") and extra record keys.
9. `jurisdiction: CENTRAL` has `stateCode: null`; `STATE` needs one. This holds for Acts and obligations.
10. A person's email follows status: `UNCLAIMED` has none, `INVITED` and `ACTIVE` need one, `DISABLED` may have either.
11. Membership shape follows role: firm roles have no `clientId`, client roles need one; only `CONSULTANT` has
    `consultantClientIds` (required); only `OWNER`/`APPROVER` may have `unitIds` (non-empty, or null for all units);
    `VIEWER` needs `expiresAt`.
12. Instance consistency: `pendingKind` is set exactly while `SUBMITTED`; `completedOn` is required for `APPROVED`,
    `NOT_APPLICABLE` and a `COMPLETION` submission; `naReason` for `NOT_APPLICABLE` and an `NA` submission;
    `periodEnd >= periodStart`.
13. `ScoreResult.onTimeRate` is a percentage with one decimal like `score` (0-100), not a 0-1 fraction.
    `counts[s]` always equals `instanceIds[s].length`, and an `InstanceRow` has `overdueDays` exactly when its status is
    `OVERDUE`. At least one criticality weight must be above zero.
14. An `ImportIssue`'s severity is fixed by its type (the table in domain-model.md §6), and `editedValue` is set exactly
    when the decision is `EDITED`.
15. `ImportRow` and `ImportIssue` carry no `firmId` in the API shape: they are always read through their batch, which
    does. Their tables still need `firm_id` and an RLS policy like every other client-data table (root CLAUDE.md
    non-negotiable 1); M3 adds the column.
16. Clients parse every response with `tolerant(endpoint.response)`. It keeps unknown keys, reads an unknown enum value
    as `"UNKNOWN"`, reads an object with an unknown discriminator (a new recurrence kind) as `{ kind: "UNKNOWN" }`,
    accepts extra keys in enum-keyed records and drops cross-field rules; wrong types in known fields still fail.
17. Every list response is an object (`{ items, nextCursor, total? }` for pages, `{ items }` for complete lists), never
    a bare array, so fields can be added. This changed the calendar and portfolio responses in endpoints.md §6.
18. `POST /clients/{clientId}/imports` returns `{ batchId, url, headers, expiresAt }`. The batch becomes readable at
    `POST /imports/{id}/uploaded`, which records the hash, so `ImportBatch.fileSha256` is never empty.
19. `can()` action names are `<resource>.<verb>` in lower camelCase (`Action`), e.g. `instance.dueDate`. Import actions are
    `import.read`, `import.create`, `import.write` and `import.commit`.
20. Bulk create (`/assignments/bulk`) reports results by request `index`; bulk approve reports them by instance `id`.
21. Login, magic-link verify, MFA verify and invite accept all return `Me`, so the client has the CSRF token at once.
    The session cookie is `canopy_session`. Passwords are 12-200 characters; invite links last 7 days. M5 may change
    these through a contract change.
22. `Invite` and `InviteStatus` (PENDING, ACCEPTED, REVOKED, EXPIRED) are defined with the API, since the domain model had
    no invite entity. An invite names an existing person (e.g. an UNCLAIMED owner from an import) or a new one.
23. `error.details` has a fixed shape per code (`ERROR_DETAILS`, `ApiErrorResponse`); codes without details send none.
24. A `PATCH` must change something besides `version`, else `400 VALIDATION`. `PUT /clients/{clientId}/settings` takes
    either `settings` or, for a CLIENT_ADMIN, only `reminders`.
25. The overdue report returns `{ result, items }`: the ScoreResult and the overdue rows.
26. `GET /me` gives each client its FY start, time zone, the units the person can see and the periods the picker offers
    (`ClientPeriods`: current FY and quarter, FYs with generated instances, last generated month), computed by the
    server with the engine, so the web app does no FY maths.
27. `POST /clients/{clientId}/people` takes `role` (OWNER, APPROVER or CLIENT_ADMIN; default OWNER) and creates a
    membership on every unit, so the person belongs to the client under RLS. VIEWERs come through an invite.
28. A person with an email is INVITED even before an invite is sent; removing the email makes them UNCLAIMED again.
    This keeps the status rule M3's `person_email_status_check` enforces.
29. `instance.generated` is one event per created instance with `aggregateVersion: 1`, so an instance's events count
    up from its creation; there is no per-run summary event.
