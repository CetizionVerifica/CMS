# Canopy contracts v1 (module M0)

The shared shapes every module builds against. These files describe them; the code in `packages/contracts` is the
source of truth wherever it exists. Shipped in code so far: domain types, enums, entity Zod schemas and error codes
(`packages/contracts/src`). Still spec only, coming in later M0 PRs: request/response schemas and the OpenAPI 3.1 spec,
typed JSON fixtures, and the mock server.

| File | What it fixes | Main readers |
|---|---|---|
| [domain-model.md](domain-model.md) | Primitives, enums, entities, recurrence rule shape, state machine, import model, score types, `can()` signature | everyone |
| [api-conventions.md](api-conventions.md) | Paths, auth, concurrency, pagination, filters, error envelope and codes, files, versioning | M5-M13 |
| [endpoints.md](endpoints.md) | Every endpoint per provider module with role permissions | M5, M6, M7, M8, M10 (provide), M11-M13 (consume) |
| [events.md](events.md) | Domain event envelope and catalogue with payloads | M9, M10 and every producer |
| [fixtures.md](fixtures.md) | Fixture files, golden counts and scores recomputed from the sample, firm B spec | M3, M4, M8, M10, M12-M14 |
| [CHANGELOG.md](CHANGELOG.md) | Contract versions | everyone |

## Status
Version `1.0.0` (`CONTRACTS_VERSION` in `packages/contracts/src/version.ts`). The domain model in §1-8 of
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
8. Entity schemas are strict (unknown keys rejected) so fixtures and seeds cannot carry typos. Response parsing on the
   client should use the request/response schemas (PR 2), which tolerate added fields.
9. `jurisdiction: CENTRAL` has `stateCode: null`; `STATE` needs one. This holds for Acts and obligations.
10. A person's email follows status: `UNCLAIMED` has none, `INVITED` and `ACTIVE` need one, `DISABLED` may have either.
11. Membership shape follows role: firm roles have no `clientId`, client roles need one; only `CONSULTANT` has
    `consultantClientIds` (required); only `OWNER`/`APPROVER` may have `unitIds` (non-empty, or null for all units);
    `VIEWER` needs `expiresAt`.
12. Instance consistency: `pendingKind` is set exactly while `SUBMITTED`; `completedOn` is required for `APPROVED`,
    `NOT_APPLICABLE` and a `COMPLETION` submission; `naReason` for `NOT_APPLICABLE` and an `NA` submission;
    `periodEnd >= periodStart`.
13. `ScoreResult.onTimeRate` is a percentage with one decimal like `score` (0-100), not a 0-1 fraction.
14. An `ImportIssue`'s severity is fixed by its type (the table in domain-model.md §6), and `editedValue` is set exactly
    when the decision is `EDITED`.
