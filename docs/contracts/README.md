# Canopy contracts v1 (module M0)

The shared shapes every module builds against. Written as specs because no code is being written yet; when coding starts,
M0 turns these into Zod schemas, an OpenAPI 3.1 spec, typed JSON fixtures and a mock server in `packages/contracts`,
and those become the source of truth.

| File | What it fixes | Main readers |
|---|---|---|
| [domain-model.md](domain-model.md) | Primitives, enums, entities, recurrence rule shape, state machine, import model, score types, `can()` signature | everyone |
| [api-conventions.md](api-conventions.md) | Paths, auth, concurrency, pagination, filters, error envelope and codes, files, versioning | M5-M13 |
| [endpoints.md](endpoints.md) | Every endpoint per provider module with role permissions | M5, M6, M7, M8, M10 (provide), M11-M13 (consume) |
| [events.md](events.md) | Domain event envelope and catalogue with payloads | M9, M10 and every producer |
| [fixtures.md](fixtures.md) | Fixture files, golden counts and scores recomputed from the sample, firm B spec | M3, M4, M8, M10, M12-M14 |
| [CHANGELOG.md](CHANGELOG.md) | Contract versions | everyone |

## Status
Version `1.0.0-draft`. Becomes `v1` when each consumer module owner has reviewed its part (MODULES.md M0 acceptance).

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
