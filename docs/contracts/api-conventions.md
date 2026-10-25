# API conventions and error codes (contracts v1)

Owner: M0. Applies to every endpoint in `endpoints.md`. Types are in `domain-model.md`.

## 1. Basics
- Base path `/api/v1`. JSON only (`application/json; charset=utf-8`), except file bytes, which never pass through the API (presigned URLs).
- Auth by session cookie (`HttpOnly`, `Secure`, `SameSite=Lax`). State-changing requests also need the `X-CSRF-Token` header from `GET /me`.
- **Tenant comes from the session.** `firmId` is never accepted in a path, query or body. A `clientId` in the path is checked against `ctx.clientIds`.
- Every response carries `X-Request-Id` (echoed if the client sent one, else generated). It is the `requestId` in audit events and logs.
- Dates: `LocalDate` for calendar dates, `Instant` (UTC) for times. The server never shifts a `LocalDate` by time zone.
- `asOf` for derived status defaults to today in the client's time zone; read endpoints accept `?asOf=YYYY-MM-DD` (FIRM_ADMIN, CONSULTANT, VIEWER only) for "as at" reporting.
- Mock server only (`@canopy/contracts` mock, never the real API): `X-Mock-Person` (a person id or email) signs a
  request in without a session; `X-Mock-Features` (comma-separated feature flags, empty = none) replaces the account's
  features for that one request on every route, public ones too (sign-in and support verify return them in
  `Me.account.features`), the add-on gate included, so a demo user can be played without an add-on; anything but
  camelCase flags is `400 VALIDATION`. `PUT /__mock/firms/{firmId}/features`
  `{ features, isoCatalogueCopied? }` stands in for the console's switches until the next reset. The other `/__mock/*`
  routes are in `packages/contracts/README.md` and `docs/contracts/README.md` decisions 33-41 and 49.

## 2. Writes and concurrency
- Updates are `PATCH` with only changed fields plus `version`. Stale `version` → `409 STALE_VERSION` with `details.currentVersion`.
- Workflow transitions are `POST /instances/{id}/<action>` with `version` in the body. ISO machine steps are the same
  pattern, `POST /clients/{clientId}/iso/<records>/{id}/<step>` with `version` (endpoints.md §10).
- `Idempotency-Key` header (UUID) is honoured on transitions, bulk approve, import commit and export creation for 24 h: a repeat with the same key returns the first response.
  The same holds for the ISO machine steps (raising a nonconformity and planning a management review included), a
  risk item's review and closing an objective; `ENDPOINTS` marks each route that honours it (`idempotent`).
- Writes respond with the full updated resource (so the client never refetches to learn the new `version`).
- Archive = `POST /<resource>/{id}/archive` (with `reason`); restore = `POST /<resource>/{id}/restore`. There is no `DELETE` except removing evidence from an instance, which archives it. An ISO file is removed with
  `POST /clients/{clientId}/iso/files/{id}/remove` and a reason, which archives it too.

## 3. Lists: pagination, sorting, filters
- Cursor pagination: `?limit=` (default 50, max 200) `&cursor=` (opaque string from the previous page).
- Response: `{ items: T[], nextCursor: string | null, total?: number }`. `total` only when `?count=true` (it costs a count query).
- Sorting: `?sort=dueDate,-criticality` (comma list, `-` = descending). Each list declares its sortable fields; unknown → `400 VALIDATION`.
- Filters are query params named after `InstanceRow` fields. Multi-value is comma-separated (`?status=OVERDUE,DUE_SOON`). Ranges use `From`/`To` suffixes (`dueFrom`, `dueTo`, inclusive).
- Period shorthand: `?fy=2022-23` expands to that FY per the client's `fyStartMonth`; `fy` and `dueFrom/dueTo` together → `400 VALIDATION`.
- Free text: `?q=` matches title, externalRef, Act name and comments (case-insensitive, min 2 characters).
- `me` is accepted wherever a person id is (`?ownerId=me`).

Register filters (M7 `GET /clients/{clientId}/instances`, also used by M10 exports and M12 saved views):
`unitId, departmentId, actId, categoryId, ownerId, approverId, criticality, status (DerivedStatus), workflowState, timelineType, domain, dueFrom, dueTo, fy, completedFrom, completedTo, hasEvidence, q, source`.
Sortable: `dueDate, completedOn, criticality, title, actName, departmentName, ownerName, status, updatedAt`.

Saved views store exactly this query string, so a view, a dashboard link and an export all use one filter language.

`source` (`ActivitySource`, contracts 1.8.0): `LAW` lists instances of STATUTE acts, `ISO` instances of STANDARD acts
(the ISO add-on's activities); absent lists both. The register, the register export, `/me/approvals`, `/me/tasks`, the
evidence vault and the calendar take it. It means something only while the account has the ISO add-on: without it
STANDARD instances are left out and `source` is ignored, so every list is the statutory one whatever `source` says
(`source=ISO` is not an error and does not empty the list). Scores, KPIs, breakdowns and reports always
count STATUTE acts only, and a portfolio row's `dueThisWeekFilter` carries `source: 'LAW'` while the add-on is on, so a
number always equals the list its link opens (`docs/iso/plan.md` §4.6).

ISO lists (endpoints.md §10) use the same paging, `count`, `q` and comma-separated multi-values, with filters named
after the record's fields (for example `managementSystemId`, `state`, `ownerId`, `unitId`); `ownerId=me` works there
too. An approver or owner whose membership lists units sees only the records of those units and the records that name
them (plan §3.3).

## 4. Error envelope
```json
{ "error": { "code": "INVALID_TRANSITION", "message": "Instance is APPROVED; SUBMIT is not allowed.", "details": { "from": "APPROVED", "action": "SUBMIT" } }, "requestId": "..." }
```
`message` is for humans and may change; clients branch on `code` only. `details` never contains personal data from evidence or another tenant's data.

## 5. Error codes

| Code | HTTP | When | `details` |
|---|---|---|---|
| `VALIDATION` | 400 | Zod rejected the input | `{ issues: { path: string[], message: string }[] }` |
| `UNAUTHENTICATED` | 401 | No or expired session | — |
| `MFA_REQUIRED` | 401 | Firm role without MFA in this session | `{ enrolled: boolean }` |
| `FORBIDDEN` | 403 | Authenticated, in tenant, but `can()` says no | `{ action }` |
| `ACCESS_EXPIRED` | 403 | VIEWER membership past `expiresAt` | `{ expiredAt }` |
| `ACCOUNT_SUSPENDED` | 403 | The account is not TRIAL or ACTIVE: any sign-in or request while SUSPENDED; while PENDING_DELETION, sign-in by anyone but an account admin, or any route but `/me`, logout and the account export (domain-model.md §9) | `{ status }` |
| `PLAN_LIMIT_REACHED` | 403 | Creating a company, unit or invite past the plan's limit | `{ limit, max, used }` |
| `FEATURE_NOT_ENABLED` | 403 | The route belongs to an add-on the account does not have (e.g. any `/iso` route without `isoManagement`); reads too (domain-model.md §9). Checked after the session, MFA and CSRF checks and before input validation. While the add-on is off, a core route that names an ISO item by id (a STANDARD act's obligation, assignment or instance) answers it too, after its 404 and role checks | `{ feature }` |
| `FEATURE_NOT_READY` | 409 | The account has the add-on, but its set-up has not finished: an `/iso` route before the account's ISO catalogue copy is recorded (`isoCatalogueCopiedAt` null, `docs/iso/plan.md` §4.3). Retry later | `{ feature }` |
| `NOT_FOUND` | 404 | Missing, archived, **or in another tenant/client the actor cannot see** (never reveal existence) | — |
| `STALE_VERSION` | 409 | `version` mismatch | `{ currentVersion }` |
| `INVALID_TRANSITION` | 409 | Action not allowed from current workflow state, or (operator API) account status move not allowed, or (ISO) a step the record's state does not allow, or a field edit, list change, new child row or file change on a locked ISO record (`action: 'UPDATE'`) | `{ from, action }`, `{ from, to }` or `{ entity, from, action }` (`entity`: an `IsoEntityType`; `from` and `action` in upper snake case) |
| `DUPLICATE` | 409 | Unique rule broken (e.g. same obligation/unit/department assignment) | `{ field, existingId }` |
| `IMPORT_STATE` | 409 | Import step called out of order | `{ status, expected }` |
| `FIRM_CHOICE_REQUIRED` | 409 | Login without `firmId` for an email that signs in to more than one firm; sent only after the password matched in each | `{ firms: [{ id, name }] }` |
| `FILE_TOO_LARGE` | 413 | Over 20 MB import or evidence limit (evidence 25 MB) | `{ maxBytes }` |
| `UNSUPPORTED_FILE` | 415 | MIME/extension not allowed | `{ allowed }` |
| `REASON_REQUIRED` | 422 | Send back, NA, reopen, archive, due-date change without reason; on ISO routes also a cancel, a send-back, an N/A request or decision, a reassignment, a moved date or a file removal without one | — |
| `DATE_IN_FUTURE` | 422 | `completedOn` after today (client time zone) | `{ today }` |
| `EVIDENCE_REQUIRED` | 422 | Submit on `evidenceRequired` obligation with no CLEAN evidence | — |
| `EVIDENCE_NOT_READY` | 422 | Download of evidence not `CLEAN` | `{ scanStatus }` |
| `RULE_INVALID` | 422 | Recurrence rule fails engine validation | `{ issues }` |
| `IMPORT_BLOCKED` | 422 | Commit with unresolved ERROR or PENDING WARNING issues | `{ blockingIssueIds }` |
| `RATE_LIMITED` | 429 | Login, magic link, invite, export limits | `{ retryAfterSeconds }` |
| `INTERNAL` | 500 | Unexpected; logged with requestId | — |

Bulk endpoints return `200` with per-item results instead of failing the whole call:
`{ results: { id: Id, ok: boolean, error?: { code, message } , item?: InstanceRow }[] }`.

## 6. Files
- Evidence upload: `POST .../upload-url` returns `{ uploadId, url, headers, expiresAt }` (PUT, 5 min). Client PUTs bytes, then confirms with `POST .../evidence { uploadId, fileName, sha256 }`. Evidence is `PENDING` until scanned.
- Downloads: `GET /evidence/{id}/download-url` returns `{ url, expiresAt }` valid 5 minutes; each call writes an `EVIDENCE_DOWNLOAD` audit event. Signed URLs are never logged or stored.
- Allowed evidence types: pdf, png, jpg, jpeg, heic, docx, xlsx, xls, csv, txt, zip (zip scanned recursively). Max 25 MB per file.
- ISO files (`iso_file`, domain-model.md §10) follow the same rules on their own routes under
  `/clients/{clientId}/iso/files`: `POST .../upload-url { subject, fileName, mimeType, sizeBytes }`, then
  `POST .../files { subject, uploadId, fileName, sha256 }` (PENDING until scanned), a 5-minute `download-url` for CLEAN
  files only, and `POST .../files/{id}/remove { reason }`. `subject` is `{ type, id }`, one of the 11 ISO record types a
  file can belong to. They never go in the evidence table, the vault or `/evidence/{id}/*`.

## 7. Versioning
- Breaking change = new `/api/v2` path or a new field name; additive fields and new enum values are non-breaking, so clients must tolerate unknown enum values (render as "Unknown").
- The contracts package version starts at `1.0.0`; every change bumps it and adds a line to `docs/contracts/CHANGELOG.md`.
