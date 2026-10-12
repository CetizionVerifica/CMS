# Contracts changelog

## 1.0.0-draft · 2026-10-11
First draft of domain model, API conventions, endpoints with role permissions, event catalogue, error codes and fixture plan.

## 1.0.0-draft.1 · 2026-10-11
fixtures.md §3: six non-standard external IDs listed (was two).

## 1.0.0 · 2026-10-11
Domain model published as v1 in code (`packages/contracts`): primitives, every enum in domain-model.md §2, entity
Zod schemas for §3-8, engine function signatures (`EngineApi`), default firm and client settings, and error codes with
their HTTP statuses (api-conventions.md §5). Consistency rules the spec implied are now enforced; see README decisions 8-15.

## 1.0.1 · 2026-10-11
Requested by M4: `EngineApi.planNotifications` now takes the instance `id` as well, so each
`PlannedNotification` can name its `instanceId`. The input type is exported as `NotificationInput`
(`InstanceStatusInput & { id; ownerId; approverId }`); domain-model.md §4 updated to match. The new input field
is required, so this is a breaking change to the signature for callers; it shipped as a patch because M4 is its only
implementer and no caller existed yet.

## 1.1.0 · 2026-10-11
Request and response schemas for every endpoint in endpoints.md, in code (`packages/contracts/src/api`): the endpoint
table `ENDPOINTS` with paths, `can()` actions, role access, query, body and response schemas, Idempotency-Key flags;
`GET /me` (`Me`); per-code error details (`ERROR_DETAILS`, `ApiErrorResponse`); `tolerant()` for client-side parsing.
The OpenAPI 3.1 spec `openapi.json` is generated from the table. endpoints.md now spells out every path, returns lists as
objects (calendar, portfolio) and renames `instance.dueDate` to `instance.due_date`. README decisions 16-25.
`LocalDate` now carries `format: date` in JSON Schema. `checkMembershipShape` and `checkJurisdiction` are exported for
request bodies.
