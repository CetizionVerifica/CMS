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
objects (calendar, portfolio) and keeps the action `instance.dueDate`. README decisions 16-25.
`LocalDate` now carries `format: date` in JSON Schema. `checkMembershipShape` and `checkJurisdiction` are exported for
request bodies.
Also in 1.1.0, after the first audit and module requests: `SubmitBody.comment` is required (domain-model.md §5);
`PATCH /instances/{id}` needs a `reason` for every change; `AuditQuery` compares instants by time; export `filters` are
validated as a register query (`RegisterFilterQuery`); action names are camelCase (`instance.dueDate`);
`INSTANCE_EDIT_STATES` (ADR 0004 §7); `ClientSummary` carries FY start, time zone, unit count and periods (M11);
`PersonCreateBody.role` (M6); `NOTIFICATION_DEDUPE_KEY` (M9); `instance.generated` is one event per created instance
(M9). README decisions 26-29.

## 1.2.0 · 2026-10-12
Typed fixtures (fixtures.md): `firm-a.sample.json` (the sample register, recommended profile, people pseudonymised),
`firm-a.expected.json` (§3 counts for both profiles, the §4 score table, instance ids per status, breakdowns by
department, Act and criticality), `firm-a.due-dates.json` and `firm-b.synthetic.json`. New schemas `FixtureSet`,
`DueDatesFixture` and `ExpectedFixture`; the Node entry `@canopy/contracts/fixtures` adds `fixtureId`, `uuidV5` and
loaders. `mock-large.json` and the `import-edge/*.xlsx` sheets are not built yet. README decisions 30-32.

## 1.3.0 · 2026-10-12
Mock API server (`@canopy/contracts/mock`, `pnpm --filter @canopy/contracts mock`): every endpoint in `ENDPOINTS`,
served from the firm A and firm B fixtures under `/api/v1`, with the same input validation, role checks, error
envelope, CSRF, MFA and Idempotency-Key rules as api-conventions.md, and each response checked against its schema.
Firm B's `EVIDENCE_ADD` audit events now name the evidence (`entityType: evidence`) and carry the instance id in
`after`, as events.md says. The stub `can()` (domain-model.md §8) ships as `can`. README decisions 33-38.

Auth, additive, for M5 (#33): `LoginBody` takes an optional `firmId`, and its password is 1-1024 characters (the
12-character policy stays on `InviteAcceptBody`, where a password is set). New error code `FIRM_CHOICE_REQUIRED` (409,
details `{ firms: [{ id, name }] }`) for a login whose email signs in to more than one firm. `Me` gains an optional
`session.expiresAt`.

The mock answers the §5 codes the real API sends for body rejections: 422 `REASON_REQUIRED` for a missing or blank
`reason`, 413 `FILE_TOO_LARGE` and 415 `UNSUPPORTED_FILE` for uploads; other schema failures stay 400 `VALIDATION`.

## 1.4.0 · 2026-10-12
For M9: `NotificationKind` gains `APPROVAL_REQUESTED` (to the approver on `instance.submitted`) and `SENT_BACK` (to the
owner on `instance.sent_back`). These event-driven kinds dedupe on `(sourceEventId, recipientId)`
(`EVENT_NOTIFICATION_DEDUPE_KEY`, events.md §4 rule 4), and `notification.sent` carries `sourceEventId`. Additive; the
scheduled-kind key `NOTIFICATION_DEDUPE_KEY` is unchanged. `packages/db` derives its `notification_kind` enum from
this list, so it needs a migration adding the two values.

For M13: `PortfolioRow.dueThisWeekFilter` (optional, `DueThisWeekFilter`) gives the register filter behind
`dueThisWeek` (`dueFrom` = `asOf`, `dueTo` = `asOf` + 6 days, `workflowState` OPEN and SENT_BACK), so the portfolio can
link to the register showing exactly those items. The mock fills it.

## 1.4.1 · 2026-10-12
Fixtures only: firm A's client and company are now fictional ("Kestrel Metals Group", "Kestrel Aluminium") instead of
the real organisations named in the register, including the one Act title that named the company (fixtures.md §7). The
generator fails if a real organisation name reaches any firm A file. Regenerating also brought the committed firm A
JSON back in line with its generator: pseudonyms map to register people in the generator's order and Windows line
breaks in a few descriptions became plain ones; counts, states and expected scores are unchanged. The mock import's
Organization and Location columns now come from the fixture instead of hard-coded text.

## 1.4.2 · 2026-10-12
Fixtures only: firm A's site names are fictional too. The unit's town is "Kestrelganj" (was the company's real plant
town), and the other company site named in three owner comments is "Kestrelpur". The generator's real-name guard and the
fixture test now cover the company's site names as well as its organisation names (fixtures.md §7).

## 1.4.3 · 2026-10-13
For M11 and M13: `FIRM_B_AS_OF` (2024-11-15) names firm B's "today". Nothing in its data happens after it, and a mock
serving firm B should pin `today` to it. With an earlier date the demo showed "No items due" next to complied
counts, and its FY 2022-23 periods held no firm B items (fixtures.md §6). Additive; no schema change.

## 1.5.0 · 2026-10-24
For M15 (company accounts, ADR M15-0001); additive. Enums `AccountKind`, `AccountStatus` (with `ACCOUNT_TRANSITIONS`,
`canMoveAccount`, `WORKING_ACCOUNT_STATUSES`, `EXPORT_ACCOUNT_STATUSES`), `PlanLimitKey`, `SupportAccessLevel`,
`SupportGrantStatus`, `OperatorAuditAction`; primitives `Email`, `PlanCode`, `Gstin`; schemas `Plan`, `PlanLimits`,
`AccountOverride`, `Entitlements`, `Usage`, `AccountSummary`, `Subscription`, `UsageSnapshot`, `PlatformOperator`,
`OperatorAuditEvent`, `SupportGrant`, `AccountProfile`, `Account` (domain-model.md §9); account defaults
(`DEFAULT_TRIAL_DAYS` and others, `DEFAULT_ACCOUNT`). `Firm` gains `kind`, `status`, `planCode`, `trialEndsOn`, each
with a default; `Me` gains optional `account`. Error codes `ACCOUNT_SUSPENDED` and `PLAN_LIMIT_REACHED` (403);
`INVALID_TRANSITION.details` may be `{ from, to }` for an account move. Customer routes `GET /account`,
`GET|POST /account/support-grants`, `POST /account/support-grants/{id}/revoke` (M15) and
`POST /auth/support/verify` (M5); the operator table `PLATFORM_ENDPOINTS` (endpoints.md §9) and
`docs/contracts/openapi.platform.json`. Events `account.*` and `support_access.*` with the `OPERATOR` event actor.
After the 1.5.0 audit: `Account` carries no owner name or email, and the operator's
`GET /accounts/{id}/support-grants` returns `OperatorSupportGrant` (no person ids), per ADR M15-0001 decision 8.
`ACCOUNT_TRANSITIONS` follows decision 3 exactly (no TRIAL → PENDING_DELETION, no cancel back to TRIAL);
`AccountStatusBody.to` is `ACTIVE | SUSPENDED`, and a trial extension is `POST /accounts/{id}/trial`
(`AccountTrialBody`). `Person.support` (optional) marks the support person; `SUPPORT_TOKEN_SECONDS` is 60.
`UsageQuery` and `OperatorAuditQuery` refuse `to` before `from`.
Fixtures: the firm rows carry the account defaults. README decision 39.

## 1.5.1 · 2026-10-24
For M15 (ADR M15-0001 decisions 7 and 13); additive. `AuditActorKind` gains `OPERATOR` and `EntityType`
gains `account`, for the entries PlanetPulse's changes write to an account's own trail (actor id null, no client); the
database already stored both (ADR M3-0002). `Account` gains `libraryCopiedAt` (null until the master library is copied
in), so the console can flag a PROVISIONING account still waiting for it. The audit page's entity map lists `account`
already (M13), so the bump keeps web typecheck green. A patch, not 1.6.0: it completes 1.5.0 as decision 13
planned (the two enum values were deferred only until M3's migration added them), adds no route, and
`libraryCopiedAt` is on the operator's `Account` alone, which no provider serves yet (the 1.0.1 precedent).

## 1.5.2 · 2026-10-24
For M10 (ADR M15-0001 decision 4, the plan's account export); additive. `ExportKind` gains `CLIENT_ARCHIVE_ZIP`: one
client's whole register and its evidence in a zip, for account admins only, through the existing export routes, which
stay open to account admins while the account is PENDING_DELETION (endpoints.md §6, §8). The database stored the value
first (M3). No route or schema shape changes; M10's export switch has a default branch, so the bump keeps api
typecheck green.
