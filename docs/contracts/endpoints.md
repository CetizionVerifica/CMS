# Endpoints and role permissions (contracts v1)

Owner: M0. Each provider module (M5, M6, M7, M8, M10, M15, M16) implements its section exactly; M11-M13 and M17 build
against the mock of it. The endpoint table in code (`packages/contracts/src/api/endpoints.ts`, with the ISO add-on's
`ISO_ENDPOINTS` from `iso-endpoints.ts` spread into it) is the source of truth, with request and response schemas per
endpoint; `openapi.json` is generated from it. A test checks that this file and the code list the same paths.
Conventions, filters and error codes: `api-conventions.md`. Types: `domain-model.md`. All paths are under `/api/v1`.
The customer API's sections come first, §10 (the ISO add-on) included; §9, the operator API, is a separate API with
its own OpenAPI document, so it comes last.

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
| GET | `/invites/{token}` · POST `/invites/{token}/accept` | public | | | | | | | claims an UNCLAIMED person (sets email, password); when the preview says `mfaRequired` (a firm role in a firm requiring MFA), the body carries the authenticator's first code and the session starts MFA-satisfied, else `401 MFA_REQUIRED` |
| POST | `/invites/{token}/mfa/enroll` | public | | | | | | | TOTP setup for an `mfaRequired` invite before the account exists (F14); restarts until the invite is accepted; rate limited |
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
| GET | `/clients/{clientId}/instances` | `instance.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | register; filters per conventions §3, `source` (`LAW` or `ISO`) included; AP/OW limited to their units |
| GET | `/instances/{id}` | `instance.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | `InstanceDetail` with `allowedActions` |
| POST | `/instances/{id}/submit` `{ version, completedOn, comment }` | `instance.submit` | | | | | own | | CA may submit on behalf only if delegated (not v1) |
| POST | `/instances/{id}/request-na` `{ version, reason }` | `instance.submit` | | | | | own | | |
| POST | `/instances/{id}/approve` `{ version, comment? }` | `instance.approve` | | | ✓ | own | | | CA approves as delegate; audited with `delegated: true` |
| POST | `/instances/{id}/send-back` `{ version, reason }` | `instance.approve` | | | ✓ | own | | | |
| POST | `/instances/{id}/reopen` `{ version, reason }` | `instance.reopen` | ✓ | ✓ | ✓ | | | | |
| POST | `/clients/{clientId}/instances/bulk-approve` `{ items: {id, version}[], comment? }` | `instance.approve` | | | ✓ | own | | | max 200, per-item results |
| PATCH | `/instances/{id}` `{ version, ownerId?, approverId?, dueDate?, reason }` | `instance.reassign` / `instance.dueDate` | ✓ | ✓ | ✓ | | | | only while OPEN, SENT_BACK or SUBMITTED (`INSTANCE_EDIT_STATES`); every change needs a reason (it goes on the audit event); a due-date change sets `dueDateOverridden` |
| GET | `/me/approvals` | `instance.read` | | | ✓ | ✓ | | | SUBMITTED where actor is approver (CA: all in client); `source` as on the register |
| GET | `/me/tasks` | `instance.read` | | | | ✓ | ✓ | | OPEN/SENT_BACK where actor is owner, by due date; `source` as on the register |
| GET · POST | `/instances/{id}/comments` `{ body }` | `comment.read` / `comment.write` | ✓ | ✓ | ✓ | own | own | r | |
| POST | `/instances/{id}/evidence/upload-url` | `evidence.write` | ✓ | ✓ | ✓ | own | own | | only while OPEN, SENT_BACK or SUBMITTED |
| POST | `/instances/{id}/evidence` `{ uploadId, fileName, sha256 }` | `evidence.write` | ✓ | ✓ | ✓ | own | own | | |
| GET | `/instances/{id}/evidence` | `evidence.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | metadata only |
| GET | `/clients/{clientId}/evidence` (vault: unitId, actId, departmentId, uploadedFrom/To, scanStatus, q, source) | `evidence.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | AP/OW limited to their units |
| GET | `/evidence/{id}/download-url` | `evidence.download` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 5-min URL, audited |
| POST | `/evidence/{id}/remove` `{ reason }` | `evidence.remove` | ✓ | ✓ | ✓ | | own | | OW only before approval; archives, never deletes |
| GET | `/clients/{clientId}/audit` (entityType, entityId, actorId, action, from, to) | `audit.read` | ✓ | ✓ | ✓ | | | ✓ | |
| GET | `/instances/{id}/audit` | `audit.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | instance history in drawer |

Internal only (no route): `scanCallback(evidenceId, result)` called by the virus-scan job; `generateInstances(assignmentId)` called by M9.

ISO activities are instances of obligations under STANDARD acts (domain-model.md §4), so they use these routes. While
the account has the ISO add-on, the register, `/me/approvals`, `/me/tasks`, the vault and the calendar (§6) take
`source`: `LAW` (STATUTE acts), `ISO` (STANDARD acts) or absent (both). While it is off, those lists leave STANDARD
instances out whatever `source` says, every other route here that names a STANDARD instance, its comments, evidence or
audit answers `403 FEATURE_NOT_ENABLED` (after the 404 and role checks), and bulk approve refuses those ids per item
(`docs/iso/plan.md` §4.4-4.5). M6's library and assignment routes do the same for STANDARD acts, their obligations and
the assignments on them.

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
| GET | `/clients/{clientId}/calendar` (`from`, `to`, `unitId`, `source`) → `{ items: { date, items: InstanceRow[] }[] }` | `instance.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| GET | `/clients/{clientId}/reports/act-wise` · `/clients/{clientId}/reports/department-wise` → `Breakdown` · `/clients/{clientId}/reports/overdue` → `{ result, items: InstanceRow[] }` | `report.read` | ✓ | ✓ | ✓ | ✓ | | ✓ |
| POST | `/clients/{clientId}/exports` `{ kind, filters, unitId?, fy? }` → `ExportJob`; `filters` is a register query string without paging, validated like `GET /clients/{clientId}/instances` | `export.create` | ✓ | ✓ | ✓ | ✓ | | ✓ |
| GET | `/exports/{id}` · `/exports/{id}/download-url` | `export.read` | ✓ | ✓ | ✓ | ✓ | | ✓ |

AP and OW dashboards are limited to their units (and owners see the same numbers as their register filter).
Statutory numbers (portfolio, overview, breakdowns, the act-wise, department-wise and overdue reports, the certificate
PDF) count STATUTE-act instances only, with the ISO add-on on or off (`docs/iso/plan.md` §4.6); while it is on,
`PortfolioRow.dueThisWeekFilter.source` is `LAW`, so the linked register lists exactly the items counted. The ISO
export kinds (`ISO_EXPORT_KINDS`, part of `ExportKind` since 1.8.3) take the ISO list filters (`ISO_EXPORT_FILTERS`),
not the register's: the NC log and risk register their list's query without paging, the audit report
`internalAuditId=` and the review pack `managementReviewId=`. They are ISO data: while the add-on is off, creating one
and reading or downloading its job answer `403 FEATURE_NOT_ENABLED`, after the role check (`docs/iso/plan.md` §4.5).
`REGISTER_XLSX` uses the 19 sample headers in the same order so it re-imports with no changes.
`CLIENT_ARCHIVE_ZIP` is the account export, one client at a time: FA only (`403 FORBIDDEN` for anyone else), no
`filters`, `unitId` or `fy`; a zip of the client's whole register (every FY, the `REGISTER_XLSX` layout) and its clean
evidence files. The three export routes stay open to FA while the account is PENDING_DELETION (§8).

## 7. Not exposed in v1
Notification send log, job admin and library change history have no public endpoints; M9 writes audit/send-log rows only.

## 8. M15 · The account, for its own people (`apps/api/src/platform`)

An account is the firm (ADR M15-0001). In `SUSPENDED` nobody can sign in. In `PENDING_DELETION` only account admins (FA) can sign in, and
every route except `GET /me`, `POST /auth/logout` and the account export (the three export routes of §6) answers `403 ACCOUNT_SUSPENDED`. Creating a
company, unit or invite past the plan's limit answers `403 PLAN_LIMIT_REACHED` (M6, M5). `GET /me` lists the account's
features in `account.features`; a route of an add-on the account lacks answers `403 FEATURE_NOT_ENABLED` (ADR M16-0001),
and an ISO route answers `409 FEATURE_NOT_READY` until the account's ISO catalogue copy is recorded (§10).

| Method | Path | Action | FA | CO | CA | AP | OW | VI | Notes |
|---|---|---|---|---|---|---|---|---|---|
| GET | `/account` → `AccountView` | `account.read` | ✓ | | | | | | kind, status, trial end, entitlements and usage; read-only |
| GET | `/account/support-grants` → `{ items: SupportGrant[] }` | `supportGrant.read` | ✓ | | | | | | newest first; ended grants read `EXPIRED` or `REVOKED` |
| POST | `/account/support-grants` `{ level, days }` → `SupportGrant` | `supportGrant.manage` | ✓ | | | | | | `days` 1-30 (default 7); ends any live grant; Idempotency-Key |
| POST | `/account/support-grants/{id}/revoke` → `SupportGrant` | `supportGrant.manage` | ✓ | | | | | | ends its memberships and support sessions now |

## 10. M16 · ISO add-on (`apps/api/src/modules/iso`)

ISO 9001, 14001 and 45001 management systems for a client (ADR M16-0001 and M16-0002, `docs/iso/plan.md`,
`docs/iso/model.md`). The 119 routes are `ISO_ENDPOINTS` (`packages/contracts/src/api/iso-endpoints.ts`), all M16's and
all under `/clients/{clientId}/iso/`; bodies, queries and views are in `src/api/iso.ts`, types in domain-model.md §10.

**The switch.** Every route here carries `feature: 'isoManagement'` (`x-canopy-feature` in the OpenAPI document).
Without the feature on the account, every route, reads and file routes included, answers `403 FEATURE_NOT_ENABLED`
`{ feature }` after the session, MFA and CSRF checks and before input validation, the client check and the role check.
With it, every route answers `409 FEATURE_NOT_READY` `{ feature }` until the account's ISO catalogue copy is recorded
(`Account.isoCatalogueCopiedAt`, plan §4.3). The add-on's effect on §3, §4 and §6 is described there.

**Who may act.** The `Action` column is the `can()` action; the action table at the end of this section is plan §3.2
as implemented. **own** means the person named in that role on the record: its owner (a checklist row's owner, a
document's, risk item's, objective's or nonconformity's owner, an action's subject's owner), its approver (a
document's or nonconformity's approver, an action's subject's approver), the lead auditor or an auditor of an internal
audit, or the chair of a management review; M16 builds each `Resource` per action (plan §3.2). Every route has exactly
one action, so a route's roles are its action's roles. Where the action table grants them the action, FA, CO and CA may
take a step whose usual taker is the record's owner, row owner, lead auditor or chair, audited with `delegated: true`.
FA and CO take no nonconformity owner's step (`isoNc.work`) and complete no action (`isoAction.complete`); FA and CO
never take an approver's step, and only the record's approver or a CA as delegate does. Nobody takes a checker step
(APPROVE, APPROVE_NA, VERIFY_EFFECTIVE, VERIFY_NOT_EFFECTIVE) on a record where they took a maker step since its last
RAISE, REOPEN, VERIFY_NOT_EFFECTIVE or DRAFT_REVISION: `403 FORBIDDEN` (model §4).

**Scope.** Client scope as §1. AP/OW limited to their units (plan §3.3): an approver or owner whose membership lists
`unitIds` sees a record only when its unit is one of theirs; when its units list overlaps theirs (an empty list on an
internal audit or certificate means its management system's units, an empty list on a management system every unit of
the client); when it has no unit of its own and its management system's units qualify; or when it names them (owner,
approver, lead auditor, auditor, auditee, reported-to, chair, attendee or investigator). A child record (finding,
action, revision, reading, checklist row or item, control, input, output, file) takes its parent's units. Outside them a
single read or write is `404`, and lists and overview counts leave the record out. Management review figures are the
one exception (model §3.13 item 4): an input's values count the review's whole system, and each figure lists only the
ids its reader may read (so a value can be larger than its list). Incidents are the limit: when cutting an INCIDENTS
row's ids for a reader drops any id, the row answers `figuresWithheld: true`, with no `sourceFigures`,
`figuresStoredAt` or `notes`, unless the reader is the review's chair or an attendee. The test reads the incidents the
row counts, not the system's units, which can be narrowed after an incident was counted; a row with no figures, and a
client-wide reader, are never withheld. The current approved revision of a system document, and its file, stays
readable by every member of the client. The catalogue routes read the account's own copy, which is firm-wide and the
same for every client: clause numbers, titles and summaries in our own words, never a standard's text.

**Writes.** Every update and machine step carries `version` (`409 STALE_VERSION`). A step the record's state does not
allow is `409 INVALID_TRANSITION` with `{ entity, from, action }`: the ISO entity type, its state (or a checklist row's
N/A state) and the model §4 action, or `UPDATE` for a field edit, list change or new child row on a locked record
(model §1.8, §6). A failed guard is `400 VALIDATION` naming the fields; a missing reason is `422 REASON_REQUIRED`. A
person named on a record must hold a live role in its client covering its unit, else `400 VALIDATION` (model §1.5).
A field edit audited as `REASSIGN` (an owner, approver, lead auditor or chair) or `DUE_DATE_CHANGE` (a planned, due,
review or response date) needs a `reason`, and the event carries it (README decision 51 p); the body fields that take
one are listed in `src/api/iso.ts` per body, and a body that names one needs the reason even if the value is
unchanged, so send only the fields that change. A date or owner a step sets itself (RECORD_HELD's dates, a risk's review
date when a treatment action puts a control in place) needs none. Every create, edit, state change, list change and file add, remove or download writes an `AuditEvent` with
the model §8 entity type (`ISO_ENTITY_TYPES`, part of `EntityType` since 1.8.3); `GET /clients/{clientId}/audit`
lists those events with the client's other events, with the add-on on or off (`docs/iso/plan.md` §4.4).
Views of records with a machine carry `allowedActions`, the steps the signed-in person may take now. Machine steps
honour `Idempotency-Key` (api-conventions.md §2), RAISE and PLAN included, and so do a risk item's REVIEW, closing an
objective, a nonconformity's reassign and a management review's replan; DRAFT_REVISION, like every other create, does
not.

**Files** go in `iso_file`, never in `evidence` (model §6): the evidence upload rules (types, 25 MB, a 5-minute
presigned PUT), PENDING until scanned, download only when CLEAN through a 5-minute signed URL, removal with a reason
(archived, never deleted). Confirm, download and remove are audited on the subject as `EVIDENCE_ADD`,
`EVIDENCE_DOWNLOAD` and `EVIDENCE_REMOVE`. A file is added to or removed from an open subject only (`409
INVALID_TRANSITION` on a locked one). Files of an incident nonconformity and its actions download only for the
nonconformity's owner, approver and investigators, CA, CO and FA; other readers see the list and get `403 FORBIDDEN`
on the URL.

### Catalogue (the account's copy)
| Method | Path | Action | FA | CO | CA | AP | OW | VI | Notes |
|---|---|---|---|---|---|---|---|---|---|
| GET | `/clients/{clientId}/iso/catalogue/standards` | `isoSystem.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | standards and editions |
| GET | `/clients/{clientId}/iso/catalogue/clauses` (standardId, assessable) | `isoSystem.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | by standard and number: numbers, titles and our own summaries, never the text |
| GET | `/clients/{clientId}/iso/catalogue/review-defs` (standardId) → `{ inputs, outputs }` | `isoSystem.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | management review input and output definitions per standard |

### Management systems and context
| Method | Path | Action | FA | CO | CA | AP | OW | VI | Notes |
|---|---|---|---|---|---|---|---|---|---|
| GET | `/clients/{clientId}/iso/systems` (status, q) | `isoSystem.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | AP/OW limited to their units (plan §3.3) |
| POST | `/clients/{clientId}/iso/systems` | `isoSystem.write` | ✓ | ✓ | ✓ | | | | `201`; adds a NOT_STARTED checklist row per assessable clause of each standard |
| GET | `/clients/{clientId}/iso/systems/{id}` | `isoSystem.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| PATCH | `/clients/{clientId}/iso/systems/{id}` | `isoSystem.write` | ✓ | ✓ | ✓ | | | | name, scope, units, status, review interval; a standard may be added (with its checklist rows), never dropped |
| PUT | `/clients/{clientId}/iso/systems/{id}/climate` | `isoSystem.write` | ✓ | ✓ | ✓ | | | | the climate decision (Amd 1:2024, clause 4.1); may change, never back to undecided; audited |
| GET | `/clients/{clientId}/iso/systems/{id}/context` (kind, climateRelated, includeArchived) | `isoSystem.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | issues and interested parties (4.1, 4.2); AP/OW limited to their units (plan §3.3) |
| POST | `/clients/{clientId}/iso/systems/{id}/context` | `isoSystem.write` | ✓ | ✓ | ✓ | | | | `201` |
| PATCH | `/clients/{clientId}/iso/systems/{id}/context/{itemId}` | `isoSystem.write` | ✓ | ✓ | ✓ | | | | |
| POST | `/clients/{clientId}/iso/systems/{id}/context/{itemId}/archive` `{ version, reason }` | `isoSystem.write` | ✓ | ✓ | ✓ | | | | |

### Clause checklist
| Method | Path | Action | FA | CO | CA | AP | OW | VI | Notes |
|---|---|---|---|---|---|---|---|---|---|
| GET | `/clients/{clientId}/iso/systems/{id}/checklist` (standardId, status, naState, ownerId) | `isoChecklist.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | by standard and clause number; AP/OW limited to their units (plan §3.3) |
| PATCH | `/clients/{clientId}/iso/systems/{id}/checklist/{rowId}` | `isoChecklist.write` | ✓ | ✓ | ✓ | | own | | status (never NOT_APPLICABLE, refused while N/A is REQUESTED or APPROVED), owner, notes, review date; 4.1 not IMPLEMENTED before the climate decision; OW only on rows they own |
| POST | `/clients/{clientId}/iso/systems/{id}/checklist/{rowId}/na-request` `{ version, reason }` | `isoChecklist.requestNa` | ✓ | ✓ | ✓ | | own | | REQUEST_NA on a clause that allows exclusion; `reason` is stored as the justification |
| POST | `/clients/{clientId}/iso/systems/{id}/checklist/{rowId}/na-approve` | `isoChecklist.decideNa` | | | ✓ | ✓ | | | APPROVE_NA; never the requester (`403`) |
| POST | `/clients/{clientId}/iso/systems/{id}/checklist/{rowId}/na-reject` `{ version, reason }` | `isoChecklist.decideNa` | | | ✓ | ✓ | | | REJECT_NA; the row returns to its status before the request; never the requester |
| POST | `/clients/{clientId}/iso/systems/{id}/checklist/{rowId}/na-withdraw` `{ version, reason }` | `isoChecklist.requestNa` | ✓ | ✓ | ✓ | | own | | WITHDRAW_NA: the clause applies again; the row returns to NOT_STARTED |

### Documents
| Method | Path | Action | FA | CO | CA | AP | OW | VI | Notes |
|---|---|---|---|---|---|---|---|---|---|
| GET | `/clients/{clientId}/iso/documents` (managementSystemId, q, type, status, ownerId, approverId, clauseId) | `isoDocument.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ACTIVE only unless `status` says otherwise; AP/OW limited to their units (plan §3.3); a system document's current revision is readable by every member of the client |
| POST | `/clients/{clientId}/iso/documents` | `isoDocument.write` | ✓ | ✓ | ✓ | | own | | `201`, no revision yet; OW only as its owner |
| GET | `/clients/{clientId}/iso/documents/{id}` | `isoDocument.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | with its current revision and the actions on offer |
| PATCH | `/clients/{clientId}/iso/documents/{id}` | `isoDocument.write` | ✓ | ✓ | ✓ | | own | | its own fields while ACTIVE (not `code` or `type`); OW only as its owner |
| POST | `/clients/{clientId}/iso/documents/{id}/review` `{ version, note, nextReviewDueOn }` | `isoDocument.approve` | | | ✓ | own | | | REVIEW: the approver confirms the current revision |
| POST | `/clients/{clientId}/iso/documents/{id}/obsolete` `{ version, reason }` | `isoDocument.approve` | | | ✓ | own | | | MAKE_OBSOLETE; the history stays readable |
| GET | `/clients/{clientId}/iso/documents/{id}/revisions` | `isoDocument.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | newest first, superseded ones included; AP/OW limited to their units (plan §3.3) |
| POST | `/clients/{clientId}/iso/documents/{id}/revisions` | `isoDocument.write` | ✓ | ✓ | ✓ | | own | | `201`; DRAFT_REVISION: no other revision in DRAFT or IN_REVIEW; OW only as the document owner |
| PATCH | `/clients/{clientId}/iso/documents/{id}/revisions/{revisionId}` | `isoDocument.write` | ✓ | ✓ | ✓ | | own | | label or change note of a DRAFT revision |
| POST | `/clients/{clientId}/iso/documents/{id}/revisions/{revisionId}/submit` | `isoDocument.write` | ✓ | ✓ | ✓ | | own | | SUBMIT: change note and exactly one live CLEAN file; not an EXTERNAL document |
| POST | `/clients/{clientId}/iso/documents/{id}/revisions/{revisionId}/approve` | `isoDocument.approve` | | | ✓ | own | | | APPROVE: the previous approved revision becomes SUPERSEDED; never the preparer (`403`) |
| POST | `/clients/{clientId}/iso/documents/{id}/revisions/{revisionId}/send-back` `{ version, reason }` | `isoDocument.approve` | | | ✓ | own | | | SEND_BACK to DRAFT |
| POST | `/clients/{clientId}/iso/documents/{id}/revisions/{revisionId}/record-edition` | `isoDocument.write` | ✓ | ✓ | ✓ | | own | | RECORD_EDITION of an EXTERNAL document: approved once its file is CLEAN, with no internal approver |

### Risk register
| Method | Path | Action | FA | CO | CA | AP | OW | VI | Notes |
|---|---|---|---|---|---|---|---|---|---|
| GET | `/clients/{clientId}/iso/risks` (managementSystemId, q, unitId, kind, significant, climateRelated, ownerId, includeArchived) | `isoRisk.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | risks, opportunities, aspects and hazards; AP/OW limited to their units (plan §3.3) |
| POST | `/clients/{clientId}/iso/risks` | `isoRisk.write` | ✓ | ✓ | ✓ | | own | | `201`; the engine's rating and significance are stored with it; OW only as its owner, for their units |
| GET | `/clients/{clientId}/iso/risks/{id}` | `isoRisk.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| PATCH | `/clients/{clientId}/iso/risks/{id}` | `isoRisk.write` | ✓ | ✓ | ✓ | | own | | change or re-rate (not `kind`); rating and significance recomputed; OW only as its owner |
| POST | `/clients/{clientId}/iso/risks/{id}/archive` `{ version, reason }` | `isoRisk.write` | ✓ | ✓ | ✓ | | own | | its actions can no longer be reopened |
| POST | `/clients/{clientId}/iso/risks/{id}/review` `{ version, nextReviewDueOn, note? }` | `isoRisk.write` | ✓ | ✓ | ✓ | | own | | REVIEW: stands as rated; sets the next review date |
| PUT | `/clients/{clientId}/iso/risks/{id}/significance` `{ version, significantOverride, reason }` | `isoRisk.override` | ✓ | ✓ | ✓ | | | | set or clear the override; audited |
| GET | `/clients/{clientId}/iso/risks/{id}/controls` | `isoRisk.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | controls in place; AP/OW limited to their units (plan §3.3) |
| POST | `/clients/{clientId}/iso/risks/{id}/controls` | `isoRisk.write` | ✓ | ✓ | ✓ | | own | | `201`; `hierarchy` required on a HAZARD; planned controls are treatment actions |
| PATCH | `/clients/{clientId}/iso/risks/{id}/controls/{controlId}` | `isoRisk.write` | ✓ | ✓ | ✓ | | own | | OW only as the item owner |
| POST | `/clients/{clientId}/iso/risks/{id}/controls/{controlId}/archive` `{ version, reason }` | `isoRisk.write` | ✓ | ✓ | ✓ | | own | | a control no longer in place |

### Objectives
| Method | Path | Action | FA | CO | CA | AP | OW | VI | Notes |
|---|---|---|---|---|---|---|---|---|---|
| GET | `/clients/{clientId}/iso/objectives` (managementSystemId, q, standard, ownerId, open) | `isoObjective.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | with progress; AP/OW limited to their units (plan §3.3) |
| POST | `/clients/{clientId}/iso/objectives` | `isoObjective.write` | ✓ | ✓ | ✓ | | own | | `201`; one or more standards of its system; OW only as its owner |
| GET | `/clients/{clientId}/iso/objectives/{id}` | `isoObjective.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | with progress |
| PATCH | `/clients/{clientId}/iso/objectives/{id}` | `isoObjective.write` | ✓ | ✓ | ✓ | | own | | while open; moving `dueOn` or changing the owner needs a reason |
| POST | `/clients/{clientId}/iso/objectives/{id}/close` `{ version, closedOn, outcome }` | `isoObjective.write` | ✓ | ✓ | ✓ | | own | | readings and actions stop |
| GET | `/clients/{clientId}/iso/objectives/{id}/readings` | `isoObjective.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | by period; AP/OW limited to their units (plan §3.3) |
| POST | `/clients/{clientId}/iso/objectives/{id}/readings` | `isoObjective.write` | ✓ | ✓ | ✓ | | own | | `201`; on an open objective; OW only as the objective owner |
| PATCH | `/clients/{clientId}/iso/objectives/{id}/readings/{readingId}` | `isoObjective.write` | ✓ | ✓ | ✓ | | own | | correct a reading on an open objective |

### Audit programmes and internal audits
| Method | Path | Action | FA | CO | CA | AP | OW | VI | Notes |
|---|---|---|---|---|---|---|---|---|---|
| GET | `/clients/{clientId}/iso/audit-programmes` (managementSystemId, fy) | `isoAudit.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | by FY, with coverage; AP/OW limited to their units (plan §3.3) |
| POST | `/clients/{clientId}/iso/audit-programmes` | `isoSystem.write` | ✓ | ✓ | ✓ | | | | `201`; one per system and FY (`409 DUPLICATE`) |
| PATCH | `/clients/{clientId}/iso/audit-programmes/{id}` | `isoSystem.write` | ✓ | ✓ | ✓ | | | | notes |
| GET | `/clients/{clientId}/iso/internal-audits` (managementSystemId, q, programmeId, state, unitId, leadAuditorId, from, to) | `isoAudit.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | by planned start; AP/OW limited to their units (plan §3.3) |
| POST | `/clients/{clientId}/iso/internal-audits` | `isoAudit.plan` | ✓ | ✓ | ✓ | | | | `201`, PLANNED; an auditor who is also an auditee needs an independence note |
| GET | `/clients/{clientId}/iso/internal-audits/{id}` | `isoAudit.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | with the actions on offer |
| PATCH | `/clients/{clientId}/iso/internal-audits/{id}` | `isoAudit.plan` | ✓ | ✓ | ✓ | | | | while PLANNED or IN_PROGRESS; moving its dates or changing the lead auditor needs a reason |
| POST | `/clients/{clientId}/iso/internal-audits/{id}/start` | `isoAudit.conduct` | ✓ | ✓ | ✓ | own | own | | START; AP/OW only as its lead auditor or an auditor |
| POST | `/clients/{clientId}/iso/internal-audits/{id}/report` `{ version, summary, reportedOn?, reportedToIds? }` | `isoAudit.conduct` | ✓ | ✓ | ✓ | own | own | | REPORT: someone reported to and a result for every clause of the audit |
| POST | `/clients/{clientId}/iso/internal-audits/{id}/close` | `isoAudit.conduct` | ✓ | ✓ | ✓ | own | own | | CLOSE once every nonconformity it raised has left OPEN |
| POST | `/clients/{clientId}/iso/internal-audits/{id}/cancel` `{ version, reason }` | `isoAudit.plan` | ✓ | ✓ | ✓ | | | | CANCEL a PLANNED audit |
| GET | `/clients/{clientId}/iso/internal-audits/{id}/checklist` | `isoAudit.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | AP/OW limited to their units (plan §3.3) |
| POST | `/clients/{clientId}/iso/internal-audits/{id}/checklist` | `isoAudit.conduct` | ✓ | ✓ | ✓ | own | own | | `201`; while PLANNED or IN_PROGRESS |
| PATCH | `/clients/{clientId}/iso/internal-audits/{id}/checklist/{itemId}` | `isoAudit.conduct` | ✓ | ✓ | ✓ | own | own | | answer or change a row while PLANNED or IN_PROGRESS |
| GET | `/clients/{clientId}/iso/internal-audits/{id}/findings` | `isoAudit.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | AP/OW limited to their units (plan §3.3) |
| POST | `/clients/{clientId}/iso/internal-audits/{id}/findings` | `isoAudit.conduct` | ✓ | ✓ | ✓ | own | own | | `201` while IN_PROGRESS; a MAJOR_NC or MINOR_NC raises its nonconformity in the same step |
| PATCH | `/clients/{clientId}/iso/internal-audits/{id}/findings/{findingId}` | `isoAudit.conduct` | ✓ | ✓ | ✓ | own | own | | while IN_PROGRESS; limited type moves (`FindingUpdateBody`); MAJOR_NC/MINOR_NC only while its nonconformity is OPEN or ROOT_CAUSE_FOUND (else `409 INVALID_TRANSITION`) and never by that nonconformity's owner (`403 FORBIDDEN`) |

### Certification and external audits
| Method | Path | Action | FA | CO | CA | AP | OW | VI | Notes |
|---|---|---|---|---|---|---|---|---|---|
| GET | `/clients/{clientId}/iso/certifications` (managementSystemId, standardId) | `isoCertification.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | with surveillance and recertification dates; AP/OW limited to their units (plan §3.3) |
| POST | `/clients/{clientId}/iso/certifications` | `isoCertification.write` | ✓ | ✓ | ✓ | | | | `201`; one standard of a system; may be recorded before it is issued |
| PATCH | `/clients/{clientId}/iso/certifications/{id}` | `isoCertification.write` | ✓ | ✓ | ✓ | | | | issuing sets number, issue and expiry dates together |
| GET | `/clients/{clientId}/iso/external-audits` (managementSystemId, state, type, from, to) | `isoCertification.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | by start date; AP/OW limited to their units (plan §3.3) |
| POST | `/clients/{clientId}/iso/external-audits` | `isoCertification.write` | ✓ | ✓ | ✓ | | | | `201`, PLANNED; one visit may cover several standards |
| GET | `/clients/{clientId}/iso/external-audits/{id}` | `isoCertification.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | with the actions on offer |
| PATCH | `/clients/{clientId}/iso/external-audits/{id}` | `isoCertification.write` | ✓ | ✓ | ✓ | | | | until CLOSED or CANCELLED |
| POST | `/clients/{clientId}/iso/external-audits/{id}/held` | `isoCertification.write` | ✓ | ✓ | ✓ | | | | RECORD_HELD: the visit's dates; the body's report is a file on it |
| POST | `/clients/{clientId}/iso/external-audits/{id}/response` | `isoCertification.write` | ✓ | ✓ | ✓ | | | | RECORD_RESPONSE once every nonconformity its findings raised has left OPEN |
| POST | `/clients/{clientId}/iso/external-audits/{id}/close` | `isoCertification.write` | ✓ | ✓ | ✓ | | | | CLOSE with the recommendation recorded |
| POST | `/clients/{clientId}/iso/external-audits/{id}/cancel` `{ version, reason }` | `isoCertification.write` | ✓ | ✓ | ✓ | | | | CANCEL a PLANNED visit |
| GET | `/clients/{clientId}/iso/external-audits/{id}/findings` | `isoCertification.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | AP/OW limited to their units (plan §3.3) |
| POST | `/clients/{clientId}/iso/external-audits/{id}/findings` | `isoCertification.write` | ✓ | ✓ | ✓ | | | | `201` while HELD; a MAJOR_NC or MINOR_NC raises its nonconformity in the same step |
| PATCH | `/clients/{clientId}/iso/external-audits/{id}/findings/{findingId}` | `isoCertification.write` | ✓ | ✓ | ✓ | | | | while HELD; limited type moves (`FindingUpdateBody`); MAJOR_NC/MINOR_NC only while its nonconformity is OPEN or ROOT_CAUSE_FOUND (else `409 INVALID_TRANSITION`) and never by that nonconformity's owner (`403 FORBIDDEN`) |

### Nonconformities and incidents
| Method | Path | Action | FA | CO | CA | AP | OW | VI | Notes |
|---|---|---|---|---|---|---|---|---|---|
| GET | `/clients/{clientId}/iso/nonconformities` (managementSystemId, q, unitId, state, source, severity, standard, ownerId, approverId, incident, overdue) | `isoNc.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | newest first, with timing; AP/OW limited to their units (plan §3.3) |
| POST | `/clients/{clientId}/iso/nonconformities` | `isoNc.raise` | ✓ | ✓ | ✓ | ✓ | ✓ | | `201`; RAISE a nonconformity, incident or near miss for a unit the actor can see; not with an audit source (those come from findings) |
| GET | `/clients/{clientId}/iso/nonconformities/{id}` | `isoNc.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | with its timing, the finding that raised it and the actions on offer |
| PATCH | `/clients/{clientId}/iso/nonconformities/{id}` | `isoNc.work` | | | ✓ | | own | | until CLOSED or CANCELLED: the investigation fields (`NcUpdateBody`: description, unit, standards, clauses, source instance, incident details but the outcome (`lostDays` only while the outcome stays LOST_TIME), containment, correction, disposition, root cause, risk and system changes); OW only as its owner |
| POST | `/clients/{clientId}/iso/nonconformities/{id}/reassign` `{ version, ownerId?, approverId?, dueOn?, effectivenessDueOn?, severity?, incident?: { outcome, lostDays? }, reason }` | `isoNc.reassign` | ✓ | ✓ | ✓ | | | | until CLOSED or CANCELLED, with a reason; severity and the incident outcome only while OPEN or ROOT_CAUSE_FOUND (else `409 INVALID_TRANSITION`); `lostDays` comes with an outcome moving to LOST_TIME, is cleared moving from it, and never changes alone here; in any open state `400 VALIDATION` for severity on a nonconformity raised from a finding and for an incident on one without incident fields (CLOSED or CANCELLED answers `409 INVALID_TRANSITION` first) |
| POST | `/clients/{clientId}/iso/nonconformities/{id}/root-cause` | `isoNc.work` | | | ✓ | | own | | ADD_ROOT_CAUSE: containment, correction, root cause and similar occurrences |
| POST | `/clients/{clientId}/iso/nonconformities/{id}/plan-actions` `{ version, effectivenessDueOn }` | `isoNc.work` | | | ✓ | | own | | PLAN_ACTIONS: at least one OPEN action |
| POST | `/clients/{clientId}/iso/nonconformities/{id}/submit-no-action` | `isoNc.work` | | | ✓ | | own | | SUBMIT_NO_ACTION for a minor case, with the reason, risk review and system change |
| POST | `/clients/{clientId}/iso/nonconformities/{id}/submit` | `isoNc.work` | | | ✓ | | own | | SUBMIT for verification once its actions are done |
| POST | `/clients/{clientId}/iso/nonconformities/{id}/verify-effective` `{ version, effectivenessNote }` | `isoNc.verify` | | | ✓ | own | | | VERIFY_EFFECTIVE closes it; CA verifies as delegate; never a maker since the last RAISE, REOPEN or VERIFY_NOT_EFFECTIVE |
| POST | `/clients/{clientId}/iso/nonconformities/{id}/verify-not-effective` `{ version, reason, backTo, effectivenessDueOn? }` | `isoNc.verify` | | | ✓ | own | | | back to OPEN or ACTIONS_PLANNED; the same maker-checker rule |
| POST | `/clients/{clientId}/iso/nonconformities/{id}/cancel` `{ version, reason }` | `isoNc.cancel` | | | ✓ | own | | | CANCEL (final) |
| POST | `/clients/{clientId}/iso/nonconformities/{id}/reopen` `{ version, reason, backTo, effectivenessDueOn? }` | `isoNc.reopen` | | | ✓ | | | | REOPEN a CLOSED nonconformity to OPEN or ACTIONS_PLANNED |

### Actions (every subject)
| Method | Path | Action | FA | CO | CA | AP | OW | VI | Notes |
|---|---|---|---|---|---|---|---|---|---|
| GET | `/clients/{clientId}/iso/actions` (managementSystemId, q, subjectType, subjectId, ownerId, state, overdue, from, to) | `isoAction.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | by due date; AP/OW limited to their units (plan §3.3) |
| POST | `/clients/{clientId}/iso/actions` | `isoAction.write` | ✓ | ✓ | ✓ | | own | | `201` on an open subject; none on a MAJOR_NC, MINOR_NC or GOOD_PRACTICE finding; OW only as the subject's owner |
| GET | `/clients/{clientId}/iso/actions/{id}` | `isoAction.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | with the actions on offer |
| PATCH | `/clients/{clientId}/iso/actions/{id}` | `isoAction.write` | ✓ | ✓ | ✓ | | own | | while OPEN; a new owner or due date needs a reason |
| POST | `/clients/{clientId}/iso/actions/{id}/complete` `{ version, doneOn, effectivenessNote? }` | `isoAction.complete` | | | ✓ | | own | | COMPLETE: OPEN to DONE; on a risk item it also adds the control; OW only as the action's owner |
| POST | `/clients/{clientId}/iso/actions/{id}/cancel` `{ version, reason }` | `isoAction.cancel` | | | ✓ | own | | | CANCEL an OPEN action; AP only as the subject's approver |
| POST | `/clients/{clientId}/iso/actions/{id}/reopen` `{ version, reason }` | `isoAction.reopen` | | | ✓ | | | | REOPEN a DONE or CANCELLED action while its subject is open |

### Management reviews
| Method | Path | Action | FA | CO | CA | AP | OW | VI | Notes |
|---|---|---|---|---|---|---|---|---|---|
| GET | `/clients/{clientId}/iso/management-reviews` (managementSystemId, q, state, from, to) | `isoReview.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | by planned date; AP/OW limited to their units (plan §3.3) |
| POST | `/clients/{clientId}/iso/management-reviews` | `isoReview.plan` | ✓ | ✓ | ✓ | | | | `201`; PLAN: its input and output rows come with it |
| GET | `/clients/{clientId}/iso/management-reviews/{id}` | `isoReview.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | with the actions on offer |
| PATCH | `/clients/{clientId}/iso/management-reviews/{id}` `{ version, attendeeIds?, minutes? }` | `isoReview.write` | ✓ | ✓ | ✓ | own | own | | attendees and minutes until CLOSED or CANCELLED; AP/OW only as its chair |
| POST | `/clients/{clientId}/iso/management-reviews/{id}/replan` `{ version, standards?, plannedOn?, chairId?, reason? }` | `isoReview.plan` | ✓ | ✓ | ✓ | | | | while PLANNED; a new date or chair needs a reason; changing standards adds and archives input and output rows |
| POST | `/clients/{clientId}/iso/management-reviews/{id}/cancel` `{ version, reason }` | `isoReview.plan` | ✓ | ✓ | ✓ | | | | CANCEL a PLANNED review |
| POST | `/clients/{clientId}/iso/management-reviews/{id}/held` `{ version, heldOn, attendeeIds?, minutes? }` | `isoReview.write` | ✓ | ✓ | ✓ | own | own | | RECORD_HELD: notes on every input; stores each input's figures as of `heldOn`; AP/OW only as its chair |
| POST | `/clients/{clientId}/iso/management-reviews/{id}/close` | `isoReview.write` | ✓ | ✓ | ✓ | own | own | | CLOSE: a decision on every output, every review action DONE or CANCELLED |
| GET | `/clients/{clientId}/iso/management-reviews/{id}/inputs` | `isoReview.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | each with its source's figures: stored at RECORD_HELD for a HELD or CLOSED review (none for one held before its system was set up), computed for a PLANNED one; values cover the whole system, ids only the records the reader may read; the INCIDENTS row withheld, figures and notes, from a reader who may not read every incident it counts and is neither chair nor attendee (Scope above) |
| PATCH | `/clients/{clientId}/iso/management-reviews/{id}/inputs/{inputId}` | `isoReview.write` | ✓ | ✓ | ✓ | own | own | | notes on one input |
| GET | `/clients/{clientId}/iso/management-reviews/{id}/outputs` | `isoReview.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | AP/OW limited to their units (plan §3.3) |
| PATCH | `/clients/{clientId}/iso/management-reviews/{id}/outputs/{outputId}` | `isoReview.write` | ✓ | ✓ | ✓ | own | own | | the decision on one output |

### Files and overview
| Method | Path | Action | FA | CO | CA | AP | OW | VI | Notes |
|---|---|---|---|---|---|---|---|---|---|
| POST | `/clients/{clientId}/iso/files/upload-url` `{ subject, fileName, mimeType, sizeBytes }` → `UploadTicket` | `isoFile.write` | ✓ | ✓ | ✓ | own | own | | presigned PUT (5 minutes) for one file on an open record; whoever may write the subject |
| POST | `/clients/{clientId}/iso/files` `{ subject, uploadId, fileName, sha256 }` → `IsoFileView` | `isoFile.write` | ✓ | ✓ | ✓ | own | own | | `201`, PENDING until scanned; audited as `EVIDENCE_ADD` on the subject |
| GET | `/clients/{clientId}/iso/files` (subjectType, subjectId, includeRemoved) | `isoFile.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | one record's files; whoever may read the subject; never a URL; AP/OW limited to their units (plan §3.3) |
| GET | `/clients/{clientId}/iso/files/{id}/download-url` | `isoFile.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 5-minute URL, CLEAN files only, audited as `EVIDENCE_DOWNLOAD`; an incident's files only for its owner, approver and investigators, CA, CO and FA |
| POST | `/clients/{clientId}/iso/files/{id}/remove` `{ reason }` → `IsoFileView` | `isoFile.write` | ✓ | ✓ | ✓ | own | own | | archives, never deletes; from an open record only |
| GET | `/clients/{clientId}/iso/overview` (managementSystemId, asOf) → `IsoOverview` | `isoSystem.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | KPIs per management system, every number with the ids behind it; AP/OW limited to their units (plan §3.3) |

### `can()` actions (plan §3.2 as implemented)

ISO-4b adds one `POLICY` row per action. "own" is the person named in that role on the record, as above.

| Action | FA | CO | CA | AP | OW | VI | Covers |
|---|---|---|---|---|---|---|---|
| `isoSystem.read`, `isoChecklist.read`, `isoDocument.read`, `isoRisk.read`, `isoObjective.read`, `isoAudit.read`, `isoCertification.read`, `isoNc.read`, `isoAction.read`, `isoReview.read`, `isoFile.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | reads and lists; `isoSystem.read` also the catalogue and the overview; `isoFile.read` file lists and download URLs (an incident's files only for the people named above) |
| `isoSystem.write` | ✓ | ✓ | ✓ | | | | systems, scope, units, context items, climate decision, audit programmes |
| `isoChecklist.write` | ✓ | ✓ | ✓ | | own | | a row's status, owner, notes, review date and files (own = row owner) |
| `isoChecklist.requestNa` | ✓ | ✓ | ✓ | | own | | REQUEST_NA, WITHDRAW_NA |
| `isoChecklist.decideNa` | | | ✓ | ✓ | | | APPROVE_NA, REJECT_NA (never the requester) |
| `isoDocument.write` | ✓ | ✓ | ✓ | | own | | documents, revisions, DRAFT_REVISION, SUBMIT, RECORD_EDITION (own = document owner) |
| `isoDocument.approve` | | | ✓ | own | | | revision APPROVE and SEND_BACK, document REVIEW and MAKE_OBSOLETE (own = document approver) |
| `isoRisk.write` | ✓ | ✓ | ✓ | | own | | risk items, controls, REVIEW, archive (own = item owner) |
| `isoRisk.override` | ✓ | ✓ | ✓ | | | | the significance override |
| `isoObjective.write` | ✓ | ✓ | ✓ | | own | | objectives, readings, close (own = objective owner) |
| `isoAudit.plan` | ✓ | ✓ | ✓ | | | | plan, edit and cancel internal audits |
| `isoAudit.conduct` | ✓ | ✓ | ✓ | own | own | | START, checklist items, findings, REPORT, CLOSE (own = lead auditor or auditor) |
| `isoCertification.write` | ✓ | ✓ | ✓ | | | | certificates, external audits and their findings |
| `isoNc.raise` | ✓ | ✓ | ✓ | ✓ | ✓ | | RAISE, for a unit the actor can see |
| `isoNc.work` | | | ✓ | | own | | investigation fields, ADD_ROOT_CAUSE, PLAN_ACTIONS, SUBMIT, SUBMIT_NO_ACTION (own = NC owner) |
| `isoNc.reassign` | ✓ | ✓ | ✓ | | | | a nonconformity's owner, approver, `dueOn`, `effectivenessDueOn`, severity and the incident outcome, with a reason (README decision 51 h, o) |
| `isoNc.verify` | | | ✓ | own | | | VERIFY_EFFECTIVE, VERIFY_NOT_EFFECTIVE (own = NC approver) |
| `isoNc.cancel` | | | ✓ | own | | | CANCEL |
| `isoNc.reopen` | | | ✓ | | | | REOPEN |
| `isoAction.write` | ✓ | ✓ | ✓ | | own | | create and edit actions (own = owner of the subject) |
| `isoAction.complete` | | | ✓ | | own | | COMPLETE (own = action owner) |
| `isoAction.cancel` | | | ✓ | own | | | CANCEL (own = approver of the subject; findings, reviews, risk items and objectives have none, so only CA) |
| `isoAction.reopen` | | | ✓ | | | | REOPEN |
| `isoReview.plan` | ✓ | ✓ | ✓ | | | | PLAN, CANCEL, and replanning a PLANNED review's standards, date and chair |
| `isoReview.write` | ✓ | ✓ | ✓ | own | own | | attendees and minutes, inputs, RECORD_HELD, outputs, CLOSE (own = chair) |
| `isoFile.write` | ✓ | ✓ | ✓ | own | own | | upload, confirm, remove: whoever may write the subject |

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
| POST | `/accounts/{id}/status` `{ version, to: ACTIVE \| SUSPENDED, reason }` → `Account` | convert, suspend, resume; must pass `canMoveAccount`, else `409 INVALID_TRANSITION` `{ from, to }` |
| POST | `/accounts/{id}/trial` `{ version, trialEndsOn, reason? }` → `Account` | moves a TRIAL account's trial end; the status stays TRIAL; any other status `409 INVALID_TRANSITION` |
| POST | `/accounts/{id}/plan` `{ version, planCode, reason }` → `Account` | |
| PUT | `/accounts/{id}/override` `{ version, override, reason }` → `Account` | `override.removedFeatures` turns a plan feature off for this account; the console's add-on switches (`KNOWN_FEATURES`) write it |
| POST | `/accounts/{id}/owner-invite` | `202`; PROVISIONING only; earlier links stop working |
| POST | `/accounts/{id}/onboarded` `{ version }` → `Account` | |
| POST | `/accounts/{id}/deletion` `{ version, reason, confirmName }` → `Account` | `PENDING_DELETION` for 30 days (ADR M15-0002) |
| POST | `/accounts/{id}/deletion/cancel` `{ version, reason }` → `Account` | back to the status it left |
| GET | `/accounts/{id}/subscriptions` → `{ items: Subscription[] }` · POST `SubscriptionCreateBody` → `Subscription` | POST is `201` with Idempotency-Key |
| GET | `/accounts/{id}/usage` (`from`, `to`) → `{ items: UsageSnapshot[] }` | `to` not before `from` |
| GET | `/accounts/{id}/support-grants` → `{ items: OperatorSupportGrant[] }` | non-personal columns only: no person ids (ADR M15-0001 decision 8) |
| POST | `/support-grants/{id}/sessions` → `SupportSession` | `201`; live grants only, else `403 ACCESS_EXPIRED` |
| GET | `/renewals` (`withinDays`, default 30) → `{ items: Renewal[] }` | |
| GET | `/audit` (`accountId`, `action`, `from`, `to`, paging) → `{ items: OperatorAuditEvent[], nextCursor }` | the console exports to Excel; `to` not before `from` |
