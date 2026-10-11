# apps/api: backend, auth, roles, workflow

Fastify + Zod, REST, OpenAPI generated from the Zod schemas. Root `CLAUDE.md` applies.

## Structure
```
src/
  modules/<area>/        routes.ts, schemas.ts, service.ts, service.test.ts
    clients, entities, people, library, assignments, instances, evidence, approvals, imports, reports, dashboard, audit
  auth/                  sessions, magic links, MFA, permission checks
  jobs/                  pg-boss workers: generate-instances, reminders, exports, virus-scan
  lib/                   tenant context, errors, pagination, logger
```
Routes are thin: validate, authorise, call the service. Services own transactions. Compliance maths comes from `packages/engine`.

## Roles and permissions
Roles: `FIRM_ADMIN`, `CONSULTANT`, `CLIENT_ADMIN`, `APPROVER`, `OWNER`, `VIEWER`. Permissions are checked by `can(actor, action, resource)` in `auth/policy.ts`, one table of rules, unit-tested per role.
- Consultants see only clients they are assigned to. Client roles see only their own client, and owners/approvers by default only their units.
- An owner can act only on instances where they are the owner; an approver only where they are the approver (or a client admin delegates).
- Viewer/auditor access has an expiry date and is read-only including exports.

## Instance workflow (state machine, enforced in `instances/service.ts`)
```
OPEN ──submit(owner: completedOn, comment, evidence?)──▶ SUBMITTED
SUBMITTED ──approve(approver)──▶ APPROVED
SUBMITTED ──sendBack(approver, reason)──▶ SENT_BACK ──submit──▶ SUBMITTED
OPEN|SENT_BACK ──requestNA(owner, reason)──▶ SUBMITTED (kind = NA)
SUBMITTED(kind NA) ──approve──▶ NOT_APPLICABLE
APPROVED|NOT_APPLICABLE ──reopen(client admin or consultant, reason)──▶ OPEN
```
- Every transition writes an `AuditEvent` and a `Comment` in the same transaction.
- `completedOn` cannot be in the future. Reason is required for send back, NA and reopen.
- Obligations flagged "evidence required" cannot be submitted without at least one clean evidence file.
- Bulk approve is allowed, processed per instance, returning per-item results.
- Optimistic concurrency: transitions require the instance `version`; stale version → 409 `STALE_VERSION`.

## API conventions
- `/api/v1/...`, JSON, cursor pagination (`?cursor=&limit=`, max 200), filters as query params matching register columns.
- Errors: `{ error: { code, message, details? } }` with stable codes from `docs/contracts/api-conventions.md` §5: `VALIDATION`, `UNAUTHENTICATED`, `MFA_REQUIRED`, `FORBIDDEN`, `ACCESS_EXPIRED`, `NOT_FOUND`, 409s `STALE_VERSION`, `INVALID_TRANSITION`, `DUPLICATE`, `IMPORT_STATE`, and 422s such as `REASON_REQUIRED`, `DATE_IN_FUTURE`, `EVIDENCE_REQUIRED`, `EVIDENCE_NOT_READY`, `RULE_INVALID`. There is no generic `CONFLICT`.
- Tenant comes from the session, never from the URL or body. Client id in the URL is checked against the session's memberships.
- Evidence upload: API issues a short-lived presigned PUT; file is unavailable until the virus-scan job marks it clean. Downloads via 5-minute signed URLs, every download audited.
- Dashboard endpoints return engine results with the underlying instance ids.

## Jobs
- `generate-instances`: nightly and on assignment change; generates the current and next FY; idempotent on `(assignment_id, period_start)`.
- `reminders`: daily 07:00 client time; uses `engine.planNotifications`; dedupes sends.
- `exports`: Excel register and PDF certificate generated off-request, stored, link emailed.

## Tests
Service tests run against a real Postgres (testcontainers) with RLS on. Each module tests every role it allows and at least one it forbids.
Workflow tests cover every arrow in the state machine and every invalid transition.
