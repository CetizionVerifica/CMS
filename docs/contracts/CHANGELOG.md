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

## 1.5.3 · 2026-10-24
For M9 (ADR M15-0001 order of work step 6, M9's trial-ending reminder); additive. `NotificationKind` gains
`TRIAL_ENDING`: an email to each account admin of a TRIAL account 7 days and 1 day before its trial ends. It is a
scheduled kind with no instance, so it dedupes on `(recipientId, kind, sendDate)` like `CONSULTANT_DIGEST` (events.md
§4 rule 4). `ACCOUNT_NOTIFICATION_KINDS` lists the kinds about the whole account, whose sends name no client. The
database stored the value first (M3). No route or schema shape changes.
Also, from the 1.5.2 audit: `ExportCreateBody` now refuses `filters`, `unitId` or `fy` on a `CLIENT_ARCHIVE_ZIP`
export (400 VALIDATION), as endpoints.md §6 already said; no valid request changes.

## 1.6.0 · 2026-10-24
For M5 and M11, closing docs/security/review.md F14 (a firm user's first MFA enrolment was trust-on-first-use).
Additive: `InvitePreview` gains an optional `mfaRequired` (the invite grants FIRM_ADMIN or CONSULTANT in a firm that
requires MFA; a reader treats a missing value as false). It is optional so this bump merges green before M5's provider
sends it, and a later patch can make it required once it does; M5's accept checks the code whatever the flag says. New
public `POST /invites/{token}/mfa/enroll` answers an `MfaEnrollment` for such an invite before the account exists, and
`InviteAcceptBody` gains an optional `mfaCode`, the authenticator's first code. When the preview says `mfaRequired`, accept without a correct code is refused
(`MFA_REQUIRED`, or `VALIDATION` on `mfaCode`) and changes nothing; with one, it sets the password, completes MFA setup
and starts an MFA-satisfied session, so no session ever exists with a password and no MFA.
The mock follows the provider: accept refuses a code before setup (`MFA_REQUIRED`, `enrolled: false`) and takes only
`123456` as the first code (`MOCK_INVITE_MFA_CODE`; any other is `VALIDATION` on `mfaCode`); setup restarts freely.
Also, from the 1.5.3 audit: the `TRIAL_ENDING` and `ACCOUNT_NOTIFICATION_KINDS` comments and the 1.5.3 entry now cite
the ADR's order of work (step 6, M9's reminders), not decision 4, which is about what each status allows.

## 1.6.1 · 2026-10-24
For M9 and M5; additive. `NotificationKind` gains `RENEWAL_DUE`, an email to each account admin of an ACTIVE account
30 days and 7 days before its latest paid subscription ends (ADR M15-0001, order of work step 6), and `MFA_ENROLLED`,
an email to a person when MFA is set up on their account (docs/security/review.md F14, mitigation 3).
`ACCOUNT_NOTIFICATION_KINDS` adds `RENEWAL_DUE`. New event `person.mfa_enrolled { personId, via }` (events.md §3),
which M5 emits in the transaction that completes MFA setup, from a session or while accepting an invite. The database
stored both kinds first (M3). No route or schema shape changes.
Also, from the 1.6.1 audit: `EVENT_NOTIFICATION_KINDS` now lists every event-driven kind (`INVITE`, `MAGIC_LINK` and
`MFA_ENROLLED` join `APPROVAL_REQUESTED` and `SENT_BACK`), and README decision 40 records the trial and renewal
reminder offsets as defaults.

## 1.7.0 · 2026-10-25
For the ISO management systems add-on (ADR M16-0001, `docs/iso/plan.md` package ISO-0); additive. `KNOWN_FEATURES`
and `KnownFeature` list the add-ons the operator console switches per account, with labels: v1 has `isoManagement`
("ISO management systems"). `AccountOverride` gains optional `removedFeatures`, which turns a feature off for one
account even when its plan has it (a flag is added or removed, not both), and `effectiveFeatures(plan, override)`
spells out the rule. `AccountSummary` (so `Me.account` and `GET /account`) gains optional `features`. New error code
`FEATURE_NOT_ENABLED` (403, details `{ feature }`) for any route of an add-on the account lacks, reads included.
`ActKind` (`STATUTE`, `STANDARD`) and optional `Act.kind`, a STANDARD act being CENTRAL; optional
`Obligation.clauseRefs`, unique `ClauseNumber`s such as "7.1.5". `ISO_ENTITY_TYPES` stages the ISO audit entity
types; they join `EntityType` once M3 stores them (README decision 41). The mock lists each firm's features (firm B
has `isoManagement`, firm A none) and `PUT /__mock/firms/{firmId}/features` changes them. No route shape changes.

## 1.8.0 · 2026-10-25
For the ISO management systems add-on (ADR M16-0002, `docs/iso/packages.md` ISO-1); additive. Shapes for every
record of `docs/iso/model.md` v2 (`src/schemas/iso.ts`): the account's catalogue copy (`IsoStandard`, `IsoClause`,
`IsoReviewInputDef`, `IsoReviewOutputDef`), management systems, context items, the clause checklist, controlled
documents and revisions, risk items and controls, objectives and readings, audit programmes, internal audits and
checklist items, certifications, external audits, findings, nonconformities with incident fields, one `IsoAction`
for every subject, management reviews with inputs and outputs, and `IsoFile` (stored) with `IsoFileView` (API), plus
the state and action enums of the eight machines. Engine results in `src/schemas/iso-results.ts` and the separate
`IsoEngineApi` with `IsoMachine` and `IsoTransitionResult` in `src/engine-api.ts`; ISO reminder shapes,
`ISO_NOTIFICATION_DEDUPE_KEY` and `ISO_REMINDER_SCHEDULE` in `src/defaults.ts`. `EngineApi` and
`PlannedNotification` do not change. 117 routes in `ISO_ENDPOINTS` (`src/api/iso-endpoints.ts`, bodies, queries and
views in `src/api/iso.ts`), all M16's, all with `feature: 'isoManagement'` (`x-canopy-feature` in OpenAPI), with the
plan §3.2 actions and the new `isoNc.reassign` (endpoints.md §10). New error code `FEATURE_NOT_READY` (409, details
`{ feature }`) until an account's ISO catalogue copy is recorded; `INVALID_TRANSITION` details gain
`{ entity, from, action }`. `ISO_ENTITY_TYPES` is replaced by the v2 list of 18 (`iso_action` replaces
`corrective_action` and `review_action`; `external_audit`, `risk_control` and `audit_checklist_item` are new), and
`ISO_NOTIFICATION_KINDS` and `ISO_EXPORT_KINDS` are staged beside it; none joins its contract enum until ISO-1b.
`Obligation.clauseRefs` is reshaped to `ClauseRef { standard, clauseNumber }[]` (unique per standard and number, at
most 20, still optional). New optional or defaulted fields: `Resource.unitIds` (the stub `can()` needs an overlap
when it is present), `DueThisWeekFilter.source`, `Account.isoCatalogueCopiedAt` and `FirmSettings.isoRisk`
(`DEFAULT_ISO_RISK_RULE`). `ActivitySource` (`LAW`, `ISO`) as `source` on the register filters (so the register
export too), `MyQueueQuery`, `CalendarQuery` and `EvidenceVaultQuery`. `ExportCreateBody` still refuses ISO export
kinds; its filter check picks `ISO_EXPORT_FILTERS` for them once they join. New event `account.features_changed
{ accountId, added, removed }` (events.md "Accounts", producer M15, consumer M9). Fixtures: `iso.catalogue.json`
(201 clauses, 137 assessable, 41 review inputs and 18 outputs, 4 STANDARD acts, 1 category, 13 activities) with
`isoCatalogueRows`, `isoCatalogueId` and `isoClauseId`, and `firm-b.iso.json` (Northwind Foods Group's integrated
management system and 7 STANDARD assignments with 34 instances; fixtures.md §8). The mock serves every ISO route, gates
them (403 without the feature, 409 before the copy), honours `X-Mock-Features` per request and `isoCatalogueCopied` on
`PUT /__mock/firms/{firmId}/features`, applies the off switch and `source` on core routes, and counts STATUTE acts only
in every statutory figure; `iso-mock.md` lists the rules it picked where the model is silent. README decisions 42-51,
including the departures from the model and plan.

## 1.8.1 · 2026-10-25
ISO-1a: the fixes from the 1.8.0 audit, before M16 builds the nonconformity and management review routes. Nothing
provides or calls an ISO route yet, so the shapes that narrow do not break a module. Every ISO route now has one
action (README decision 51 o): `PATCH /nonconformities/{id}` is `isoNc.work` (CA, OW own) with the investigation
fields only, and the new `POST /nonconformities/{id}/reassign` (`NcReassignBody`) is `isoNc.reassign` (FA, CO, CA)
for owner, approver, `dueOn`, `effectivenessDueOn`, severity and the incident outcome (with `lostDays` when it moves
to or from LOST_TIME), always with a reason; severity and outcome change only while OPEN or ROOT_CAUSE_FOUND, and
severity never on a finding's nonconformity. A finding's MAJOR_NC/MINOR_NC move follows the same window and is
refused to the nonconformity's owner (403). `PATCH /management-reviews/{id}` is `isoReview.write`
(attendees and minutes) and the new `POST /management-reviews/{id}/replan` (`ManagementReviewReplanBody`) is
`isoReview.plan` for standards, date and chair while PLANNED. Both new routes honour `Idempotency-Key`. 119 routes. The reason rule (decision 51 p): every
field edit audited as `REASSIGN` or `DUE_DATE_CHANGE` needs a reason, so `ClauseAssessmentUpdateBody`,
`DocumentUpdateBody`, `RiskItemUpdateBody`, `ObjectiveUpdateBody`, `InternalAuditUpdateBody` and
`ExternalAuditUpdateBody` take one where they did not or require it for more fields. `IsoEngineApi.objectiveProgress`
takes `createdOn: LocalDate` and `{ fyStartMonth }` (decision 51 r). The overdue-system `ISO_MANAGEMENT_REVIEW_DUE`
rule sends from the first overdue day (`offsetDays: [1]` after `nextDueOn`). The OpenAPI document gives every
`x-canopy-feature` operation its 403 `FEATURE_NOT_ENABLED` and 409 `FEATURE_NOT_READY` responses, and the 11 ISO
child lists carry the unit-scope note. Decision 51 also declares the stored rules the model does not list (q) and
rewords (m). The mock: NC audit events no longer copy the description or incident location; N/A decisions need the
row's units even for an approver who owns the row; the ISO overview scopes findings by their audit; and
`X-Mock-Features` applies on every route, so sign-in and support verify return its features. `ObjectiveCreateBody` and
`PATCH /objectives/{id}` refuse a target on the wrong side of the baseline for INCREASE or DECREASE. The mock also
leaves finding descriptions out of audit events, refuses an edit that would make a no-action nonconformity need
action, names the step on clause N/A events, audits a system's status as an UPDATE, and measures a held review's
figures as the records stood on its `heldOn`, from their audit trail, with a window that never runs backwards
(`iso-mock.md`). Tests pin the catalogue to its generator (201 clauses, 137 assessable) and the
`objectiveProgress` stand-in at a client-local day boundary.

## 1.8.2 · 2026-10-25
ISO-1a2: stored management review figures and the rest of the 1.8.1 audit. A held review's figures are a record
(README decision 52): `ReviewInput` gains `sourceFigures`, `figuresStoredAt` and `figuresEngineVersion`, stored
together once at RECORD_HELD and null before, each null when absent so stored rows still parse.
`ReviewInputView.sourceFigures` is the stored copy for a HELD or CLOSED review, computed as of the client-local today
for a PLANNED one, and null for a CANCELLED review or a MANUAL input; the new `figuresStoredAt` is set exactly when it
is the stored copy. `ReviewFigure` and `ReviewInputFigures` move from `schemas/iso-results.ts` to `schemas/iso.ts`
under the same exported names. `ReviewFigureData` types the data of `reviewInputFigures` per source: every row with
`createdOn` and `archivedOn`, actions also with `subject` and `doneOn`, nonconformities with `reportedOn`, and the
event days `contextChanges`, `ratingChanges` and `notEffectiveSteps` (`ReviewFigureEventDay { entityId, on }`).
`TypedReviewInputFigures` is the signature over it; `IsoEngineApi.reviewInputFigures` keeps its untyped `data` until
M4 adopts that shape in ISO-3b, since ISO-3's engine checks itself against `IsoEngineApi` (README decision 52). This
is a patch, as 1.0.1 and 1.8.1 were: 1.8.1 narrowed request bodies and split two routes while no module provided or
called an ISO route, and 1.8.2 only adds types, an optional view field and record fields that are optional on
parse.
The mock stores the figures at RECORD_HELD as of `heldOn` over the whole system, puts their values (no ids) and the
engine version in the event, answers that copy for a HELD or CLOSED review whatever changes later, and cuts each
figure's ids to those the reader may read. It drops the 1.8.1 rebuild from the audit trail and applies model §5.4's
date rules: a nonconformity counts from the later of its creation day and `reportedOn`; records archived, closed or
done after as-of count as live, open or OPEN; event days are client-local; the clearing of a residual rating by a
treatment action is not a re-rating; a review not held counts as of the client-local today, and RECORD_HELD refuses a `heldOn` after it; a stored id
keeps its place for every reader who may read the record, an instance archived since included. The fixtures' held review
gets its figures when the mock loads. An `Idempotency-Key` is cached per caller, route and record, so the same key
on another record is a new request. A test pins the role matrix the stub `can()` reads: every ISO action has the same
access on every route that checks it, and only the four older actions whose routes differ (`audit.read`,
`instance.read`, `library.read`, `person.read`) may over-grant in the stub, which M5's policy settles. Decision 51 p
says M13's and M17's edit forms send only the fields the person changed.

## 1.8.3 · 2026-10-26
ISO-1b: the staged ISO values join their contract enums (README decision 53). `ISO_ENTITY_TYPES` are the last values of
`EntityType`, `ISO_NOTIFICATION_KINDS` of `NotificationKind` and `ISO_EXPORT_KINDS` of `ExportKind`, in their own
order, so the Postgres enums keep theirs; the staged constants and their `Iso*` enums stay as subsets. M3 already
stores every value (ISO-2b), M13 labels the entity types (ISO-12a) and M10 refuses at create a kind it does not build
yet (ISO-11e), so this is a patch. `ExportCreateBody` now takes the ISO kinds, checking their filters against
`ISO_EXPORT_FILTERS` as 1.8.0 set up; no schema shape changes. `IsoFixtureSet` gains `auditEvents` and
`firm-b.iso.json` a sample of Northwind's ISO audit trail (158 events: the system's set-up with its 137 checklist rows,
one record of each other kind created, and one form's first revision from draft to approval), each event as the mock's
route writes it, leaving out every step the mock's rules or the held review's figures read. The mock moves ISO events
into firm B's `auditEvents`, so the client audit trail lists and filters them, with the add-on on or off; it creates the
ISO export kinds (`.xlsx` or `.pdf`) and, while the add-on is off, answers `403 FEATURE_NOT_ENABLED` on their create,
job read and download, after the role check.
