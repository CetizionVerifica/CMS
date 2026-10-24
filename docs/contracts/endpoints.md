# Endpoints and role permissions (contracts v1)

Owner: M0. Each provider module (M5, M6, M7, M8, M10, M15) implements its section exactly; M11-M13 build against the mock of it.
The endpoint table in code (`packages/contracts/src/api/endpoints.ts`) is the source of truth, with request and response
schemas per endpoint; `openapi.json` is generated from it. A test checks that this file and the code list the same paths.
Conventions, filters and error codes: `api-conventions.md`. Types: `domain-model.md`. All paths are under `/api/v1`.

## 1. Role legend and scoping

| Code | Role | Scope |
|---|---|---|
| FA | FIRM_ADMIN | Every client of the firm |
| CO | CONSULTANT | Only `consultantClientIds` |
| CA | CLIENT_ADMIN | Own client, all units |
| AP | APPROVER | Own client; units in `unitIds` (all if null) |
| OW | OWNER | Own client; units in `unitIds` (all if null) |
| VI | VIEWER | Own client (or listed clients), read-only, until `expiresAt` |

Cell marks in the tables: **✓** allowed in scope · **own** only on instances where the actor is the instance owner (OW) or approver (AP) · **r** read-only · blank = `403 FORBIDDEN` (or `404` when the resource is outside the actor's clients).
The `Action` column is the `can()` action name; the M5 policy table has one row per action.

## 2. M5 · Auth, sessions, invites (`apps/api/src/auth`)

| Method | Path | Action | FA | CO | CA | AP | OW | VI | Notes |
|---|---|---|---|---|---|---|---|---|---|
| POST | `/auth/login` | public | | | | | | | email + password (+ optional `firmId`); `409 FIRM_CHOICE_REQUIRED` when the email is in several firms; rate limited |
| POST | `/auth/magic-link` | public | | | | | | | always `202`, no account enumeration |
| POST | `/auth/magic-link/verify` | public | | | | | | | token → session |
| POST | `/auth/logout` | session | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| POST | `/auth/mfa/enroll` · `/auth/mfa/verify` | session | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | required for FA, CO |
| GET | `/me` | session | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | person, memberships, clients (`ClientSummary`: FY start, time zone, unit count and the periods the picker offers, computed by the engine), csrf token, MFA state |
| POST | `/invites` | `person.invite` | ✓ | ✓ | ✓ | | | | CO/CA may invite only client roles in their clients; only FA invites FA/CO |
| GET | `/invites/{token}` · POST `/invites/{token}/accept` | public | | | | | | | claims an UNCLAIMED person (sets email, password) |
| POST | `/invites/{id}/revoke` | `person.invite` | ✓ | ✓ | ✓ | | | | |
| POST | `/auth/support/verify` | public | | | | | | | one-time token from the operator console → a support session for the grant's support person (ADR M15-0001 decision 11); MFA counts as satisfied |

## 3. M6 · Library and entities (`apps/api/src/modules/{clients,entities,people,library,assignments}`)

### Clients, entities, locations, departments
| Method | Path | Action | FA | CO | CA | AP | OW | VI |
|---|---|---|---|---|---|---|---|---|
| GET | `/clients` | `client.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| POST | `/clients` | `client.create` | ✓ | | | | | |
| GET | `/clients/{clientId}` | `client.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| PATCH | `/clients/{clientId}` | `client.update` | ✓ | ✓ | | | | |
| POST | `/clients/{clientId}/archive` · `/clients/{clientId}/restore` | `client.archive` | ✓ | | | | | |
| GET · PUT | `/clients/{clientId}/settings` | `client.settings` | ✓ | ✓ | r (PUT reminders only) | | | |
| GET · POST | `/clients/{clientId}/companies` | `entity.read` / `entity.write` | ✓ | ✓ | ✓ | r | r | r |
| PATCH | `/companies/{id}` · POST `/companies/{id}/archive` | `entity.write` | ✓ | ✓ | ✓ | | | |
| GET · POST | `/clients/{clientId}/units` | `entity.read` / `entity.write` | ✓ | ✓ | ✓ | r | r | r |
| PATCH | `/units/{id}` · POST `/units/{id}/archive` | `entity.write` | ✓ | ✓ | ✓ | | | |
| GET · POST | `/locations` | `location.read` / `location.write` | ✓ | ✓ | r/✓ | r | r | r |
| GET · POST | `/clients/{clientId}/departments` | `department.read` / `department.write` | ✓ | ✓ | ✓ | r | r | r |
| PATCH | `/departments/{id}` (name, aliases) | `department.write` | ✓ | ✓ | ✓ | | | |
| POST | `/departments/{id}/merge` `{ sourceIds }` | `department.merge` | ✓ | ✓ | ✓ | | | |

### People and memberships
| Method | Path | Action | FA | CO | CA | AP | OW | VI |
|---|---|---|---|---|---|---|---|---|
| GET | `/people` (firm staff) | `person.read` | ✓ | ✓ | | | | |
| GET · POST | `/clients/{clientId}/people` (POST `{ displayName, email?, role? }`: role OWNER, APPROVER or CLIENT_ADMIN, default OWNER, as a membership on every unit) | `person.read` / `person.write` | ✓ | ✓ | ✓ | r | r | r |
| PATCH | `/people/{id}` | `person.write` | ✓ | ✓ | ✓ | | | |
| POST | `/people/{id}/merge` `{ sourceIds }` | `person.merge` | ✓ | ✓ | ✓ | | | |
| GET · POST | `/people/{id}/memberships` | `membership.write` | ✓ | ✓ | ✓ | | | |
| PATCH | `/memberships/{id}` · POST `/memberships/{id}/archive` | `membership.write` | ✓ | ✓ | ✓ | | | |

CA can manage only client roles (CA, AP, OW, VI) for their own client; granting FA/CO is FA only. VIEWER memberships require `expiresAt`.

### Library (firm-wide)
| Method | Path | Action | FA | CO | CA | AP | OW | VI |
|---|---|---|---|---|---|---|---|---|
| GET · POST | `/library/acts` | `library.read` / `library.write` | ✓ | ✓ | r | r | r | r |
| PATCH | `/library/acts/{id}` · POST `/library/acts/{id}/merge` | `library.write` | ✓ | ✓ | | | | |
| GET · POST | `/library/categories` · PATCH `/library/categories/{id}` · POST `/library/categories/{id}/merge` | `library.*` | ✓ | ✓ | r | r | r | r |
| GET | `/library/obligations` (filters: actId, categoryId, domain, criticality, jurisdiction, stateCode, ruleStatus, q) | `library.read` | ✓ | ✓ | r | r | r | r |
| POST | `/library/obligations` | `library.write` | ✓ | ✓ | | | | |
| GET · PATCH | `/library/obligations/{id}` | `library.read` / `library.write` | ✓ | ✓ | r | r | r | r |
| POST | `/library/obligations/{id}/archive` | `library.write` | ✓ | ✓ | | | | |
| POST | `/library/rules/preview` `{ rule, from, to, fyStartMonth }` → `GeneratedPeriod[]` | `library.read` | ✓ | ✓ | ✓ | | | |
| POST | `/library/obligations/{id}/push` `{ clientIds }` (apply new libraryVersion to assignments' future instances) | `library.push` | ✓ | ✓ | | | | |

CA, AP, OW and VI see only obligations that have an assignment in their client (library reads are filtered, not forbidden).

### Assignments
| Method | Path | Action | FA | CO | CA | AP | OW | VI |
|---|---|---|---|---|---|---|---|---|
| GET | `/clients/{clientId}/assignments` (filters: unitId, departmentId, obligationId, applicability, ownerId, approverId) | `assignment.read` | ✓ | ✓ | ✓ | r | r | r |
| POST | `/clients/{clientId}/assignments` · `/clients/{clientId}/assignments/bulk` (per-item results, by request index) | `assignment.write` | ✓ | ✓ | ✓ | | | |
| PATCH | `/assignments/{id}` (department, default owner/approver, activeTo; `applyToOpen: boolean` also reassigns OPEN/SENT_BACK instances) | `assignment.write` | ✓ | ✓ | ✓ | | | |
| POST | `/assignments/{id}/applicability` `{ applicability, reason }` | `assignment.applicability` | ✓ | ✓ | ✓ | | | |
| POST | `/assignments/{id}/archive` | `assignment.write` | ✓ | ✓ | ✓ | | | |

Assignment-level NOT_APPLICABLE stops future instance generation; existing OPEN instances are left for the owner/approver NA flow (PLAN §7.6: NA needs approver sign-off per instance).

## 4. M7 · Workflow, evidence, comments, audit (`apps/api/src/modules/{instances,evidence,approvals,audit}`)

| Method | Path | Action | FA | CO | CA | AP | OW | VI | Notes |
|---|---|---|---|---|---|---|---|---|---|
| GET | `/clients/{clientId}/instances` | `instance.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | register; filters per conventions §3; AP/OW limited to their units |
| GET | `/instances/{id}` | `instance.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | `InstanceDetail` with `allowedActions` |
| POST | `/instances/{id}/submit` `{ version, completedOn, comment }` | `instance.submit` | | | | | own | | CA may submit on behalf only if delegated (not v1) |
| POST | `/instances/{id}/request-na` `{ version, reason }` | `instance.submit` | | | | | own | | |
| POST | `/instances/{id}/approve` `{ version, comment? }` | `instance.approve` | | | ✓ | own | | | CA approves as delegate; audited with `delegated: true` |
| POST | `/instances/{id}/send-back` `{ version, reason }` | `instance.approve` | | | ✓ | own | | | |
| POST | `/instances/{id}/reopen` `{ version, reason }` | `instance.reopen` | ✓ | ✓ | ✓ | | | | |
| POST | `/clients/{clientId}/instances/bulk-approve` `{ items: {id, version}[], comment? }` | `instance.approve` | | | ✓ | own | | | max 200, per-item results |
| PATCH | `/instances/{id}` `{ version, ownerId?, approverId?, dueDate?, reason }` | `instance.reassign` / `instance.dueDate` | ✓ | ✓ | ✓ | | | | only while OPEN, SENT_BACK or SUBMITTED (`INSTANCE_EDIT_STATES`); every change needs a reason (it goes on the audit event); a due-date change sets `dueDateOverridden` |
| GET | `/me/approvals` | `instance.read` | | | ✓ | ✓ | | | SUBMITTED where actor is approver (CA: all in client) |
| GET | `/me/tasks` | `instance.read` | | | | ✓ | ✓ | | OPEN/SENT_BACK where actor is owner, by due date |
| GET · POST | `/instances/{id}/comments` `{ body }` | `comment.read` / `comment.write` | ✓ | ✓ | ✓ | own | own | r | |
| POST | `/instances/{id}/evidence/upload-url` | `evidence.write` | ✓ | ✓ | ✓ | own | own | | only while OPEN, SENT_BACK or SUBMITTED |
| POST | `/instances/{id}/evidence` `{ uploadId, fileName, sha256 }` | `evidence.write` | ✓ | ✓ | ✓ | own | own | | |
| GET | `/instances/{id}/evidence` | `evidence.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | metadata only |
| GET | `/clients/{clientId}/evidence` (vault: unitId, actId, departmentId, uploadedFrom/To, scanStatus, q) | `evidence.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | AP/OW limited to their units |
| GET | `/evidence/{id}/download-url` | `evidence.download` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 5-min URL, audited |
| POST | `/evidence/{id}/remove` `{ reason }` | `evidence.remove` | ✓ | ✓ | ✓ | | own | | OW only before approval; archives, never deletes |
| GET | `/clients/{clientId}/audit` (entityType, entityId, actorId, action, from, to) | `audit.read` | ✓ | ✓ | ✓ | | | ✓ | |
| GET | `/instances/{id}/audit` | `audit.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | instance history in drawer |

Internal only (no route): `scanCallback(evidenceId, result)` called by the virus-scan job; `generateInstances(assignmentId)` called by M9.

## 5. M8 · Import (`apps/api/src/modules/imports`)

All import endpoints: FA ✓, CO ✓ (own clients), everyone else forbidden. Actions: `import.read` (GETs), `import.create`, `import.write` (later steps, templates) and `import.commit`. Steps must be called in order, else `409 IMPORT_STATE`.

| Method | Path | Moves status | Notes |
|---|---|---|---|
| POST | `/clients/{clientId}/imports` `{ fileName, sizeBytes }` | — | returns `batchId` + presigned PUT URL; the batch is readable once the uploaded step confirms the bytes |
| POST | `/imports/{id}/uploaded` `{ sha256 }` | → UPLOADED | returns sheet names and headers; suggests mapping |
| PUT | `/imports/{id}/mapping` `{ sheetName, mapping, saveAsTemplate? }` | → MAPPED | |
| POST | `/imports/{id}/parse` | → PARSED | async; poll `GET /imports/{id}` |
| GET | `/imports/{id}` | — | batch with counts and status |
| GET | `/imports/{id}/issues` (type, severity, decision) | — | grouped by `groupKey` |
| PATCH | `/imports/{id}/issues/{groupKey}` `{ decision, editedValue? }` | → REVIEWED when no PENDING remain | |
| GET | `/imports/{id}/rows` (outcome, issueType, cursor) | — | raw + mapped preview |
| POST | `/imports/{id}/dry-run` | → DRY_RUN_READY | returns `DryRunReport` |
| POST | `/imports/{id}/commit` | → COMMITTING → COMMITTED | idempotent; `422 IMPORT_BLOCKED` if blocking issues |
| POST | `/imports/{id}/cancel` | → CANCELLED | any status before COMMITTING |
| GET | `/clients/{clientId}/imports` | — | history |
| GET · POST | `/clients/{clientId}/mapping-templates` · PATCH `/mapping-templates/{id}` | — | |

## 6. M10 · Dashboards, calendar, reports, exports (`apps/api/src/modules/{dashboard,reports}`)

Query params: `fy` or `from`/`to`, `unitId`, `asOf` (FA/CO/VI). All numbers are `ScoreResult` with instance ids.

| Method | Path | Action | FA | CO | CA | AP | OW | VI |
|---|---|---|---|---|---|---|---|---|
| GET | `/portfolio` → `{ items: PortfolioRow[] }` | `dashboard.portfolio` | ✓ | ✓ | | | | |
| GET | `/clients/{clientId}/overview` → `{ result, upcoming: InstanceRow[], myTasks: InstanceRow[] }` | `dashboard.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| GET | `/clients/{clientId}/breakdowns` (`by=department\|act\|criticality\|unit\|owner`) → `Breakdown` | `dashboard.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| GET | `/clients/{clientId}/calendar` (`from`, `to`) → `{ items: { date, items: InstanceRow[] }[] }` | `instance.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| GET | `/clients/{clientId}/reports/act-wise` · `/clients/{clientId}/reports/department-wise` → `Breakdown` · `/clients/{clientId}/reports/overdue` → `{ result, items: InstanceRow[] }` | `report.read` | ✓ | ✓ | ✓ | ✓ | | ✓ |
| POST | `/clients/{clientId}/exports` `{ kind, filters, unitId?, fy? }` → `ExportJob`; `filters` is a register query string without paging, validated like `GET /clients/{clientId}/instances` | `export.create` | ✓ | ✓ | ✓ | ✓ | | ✓ |
| GET | `/exports/{id}` · `/exports/{id}/download-url` | `export.read` | ✓ | ✓ | ✓ | ✓ | | ✓ |

AP and OW dashboards are limited to their units (and owners see the same numbers as their register filter).
`REGISTER_XLSX` uses the 19 sample headers in the same order so it re-imports with no changes.

## 7. Not exposed in v1
Notification send log, job admin and library change history have no public endpoints; M9 writes audit/send-log rows only.

## 8. M15 · The account, for its own people (`apps/api/src/platform`)

An account is the firm (ADR M15-0001). In `SUSPENDED` nobody can sign in. In `PENDING_DELETION` only account admins (FA) can sign in, and
every route except `GET /me`, `POST /auth/logout` and the account export answers `403 ACCOUNT_SUSPENDED`. Creating a
company, unit or invite past the plan's limit answers `403 PLAN_LIMIT_REACHED` (M6, M5).

| Method | Path | Action | FA | CO | CA | AP | OW | VI | Notes |
|---|---|---|---|---|---|---|---|---|---|
| GET | `/account` → `AccountView` | `account.read` | ✓ | | | | | | kind, status, trial end, entitlements and usage; read-only |
| GET | `/account/support-grants` → `{ items: SupportGrant[] }` | `supportGrant.read` | ✓ | | | | | | newest first; ended grants read `EXPIRED` or `REVOKED` |
| POST | `/account/support-grants` `{ level, days }` → `SupportGrant` | `supportGrant.manage` | ✓ | | | | | | `days` 1-30 (default 7); ends any live grant; Idempotency-Key |
| POST | `/account/support-grants/{id}/revoke` → `SupportGrant` | `supportGrant.manage` | ✓ | | | | | | ends its memberships and support sessions now |

## 9. M15 · Operator API (`/api/platform/v1`, `apps/api/src/platform`)

Not part of the customer API: its own OpenAPI document (`openapi.platform.json`, from `PLATFORM_ENDPOINTS`), its own
session cookie `op_sid` and CSRF token, and no roles: every signed-in operator may call every route, and a customer
session is never accepted. Mounted only when `PLATFORM_ENABLED=true`. Paths below are relative to `/api/platform/v1`.
Every write records an `OperatorAuditEvent`; writes that change an account also write that account's `AuditEvent`
(actor kind `OPERATOR`).

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/login` `{ email, password, code }` → `OperatorMe` | public; MFA on every sign-in; rate limited |
| POST | `/auth/logout` | |
| GET | `/me` → `OperatorMe` | operator, CSRF token, session end and idle end |
| GET | `/plans` → `{ items: Plan[] }` | |
| PUT | `/plans/{code}` `PlanUpsertBody` → `Plan` | limits apply to accounts on the plan at once; nothing is removed |
| GET | `/accounts` (`status`, `kind`, `q`, paging) → `{ items: Account[], nextCursor }` | |
| POST | `/accounts` `AccountCreateBody` → `Account` | `201`; the only route that creates a firm; owner invite valid 72 hours; Idempotency-Key |
| GET | `/accounts/{id}` → `Account` · PATCH `{ version, name?, profile? }` | no client data, only counts |
| POST | `/accounts/{id}/status` `{ version, to, reason, trialEndsOn? }` → `Account` | convert, suspend, resume; `409 INVALID_TRANSITION` `{ from, to }` |
| POST | `/accounts/{id}/plan` `{ version, planCode, reason }` → `Account` | |
| PUT | `/accounts/{id}/override` `{ version, override, reason }` → `Account` | |
| POST | `/accounts/{id}/owner-invite` | `202`; PROVISIONING only; earlier links stop working |
| POST | `/accounts/{id}/onboarded` `{ version }` → `Account` | |
| POST | `/accounts/{id}/deletion` `{ version, reason, confirmName }` → `Account` | `PENDING_DELETION` for 30 days (ADR M15-0002) |
| POST | `/accounts/{id}/deletion/cancel` `{ version, reason }` → `Account` | back to the status it left |
| GET | `/accounts/{id}/subscriptions` → `{ items: Subscription[] }` · POST `SubscriptionCreateBody` → `Subscription` | POST is `201` with Idempotency-Key |
| GET | `/accounts/{id}/usage` (`from`, `to`) → `{ items: UsageSnapshot[] }` | |
| GET | `/accounts/{id}/support-grants` → `{ items: SupportGrant[] }` | |
| POST | `/support-grants/{id}/sessions` → `SupportSession` | `201`; live grants only, else `403 ACCESS_EXPIRED` |
| GET | `/renewals` (`withinDays`, default 30) → `{ items: Renewal[] }` | |
| GET | `/audit` (`accountId`, `action`, `from`, `to`, paging) → `{ items: OperatorAuditEvent[], nextCursor }` | the console exports to Excel |
