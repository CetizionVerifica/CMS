# ISO add-on: package briefs

Part of plan v2 ([plan.md](plan.md)). One brief per package. A thread gets: the root `CLAUDE.md`, `plan.md`, its brief
below, the parts of [model.md](model.md) and [catalogue.md](catalogue.md) the brief names, and the area `CLAUDE.md` of
its paths. Rules every brief shares (plan §5):

- Title PRs `M<n>: ISO ...` (ISO-14a and ISO-14b: `Tooling: ISO ...`) and change only the module's paths, plus
  shared files.
- Start only when every package in **Needs** has merged; one thread per module at a time.
- If the work must depart from the brief, say so in the PR and tell the coordinator; do not edit `docs/iso/`.
- Every package merges `main` before marking ready (plan §5.5).
- Tests with every PR; isolation test for every new table; `AuditEvent` for every state change; fictional names only
  (the ISO fixtures use firm B's Northwind Foods Group and invented people).
- ADRs go in `docs/adr/M<n>-NNNN-slug.md` with the next free number of the module's own series.
- The contracts (ISO-1, contracts 1.8.0, and its fix patches ISO-1a, 1.8.1, and ISO-1a2, 1.8.2) are the source of
  shapes, routes and role lists; the departures they took from model.md and plan §3.2 are `docs/contracts/README.md`
  decision 51 (a-n, and o from ISO-1a), already folded into these files (traces at the end). Every ISO route takes one
  `can()` action (plan §3.2). Where model.md is silent, the M0 mock had to pick a rule; its picks are in
  `docs/contracts/iso-mock.md`. M4, M16 and M17 keep each pick that touches their work, or record a different one in
  their module's ADR and tell the coordinator, who asks M0 to change the mock so screens tested against it and the real
  API agree.

Started packages keep their ids and scopes; the first-wave briefs those threads received are summarised here with what
v2 adds around them. Status is as of 2026-10-26 (`origin/main` at #291); plan §6 holds the current status.

---

## ISO-0 · M0 · Feature contracts (contracts 1.7.0)
- **Status:** merged (#247, contracts 1.7.0). Nothing in v2 changes it.
- **Delivered:** `KNOWN_FEATURES` and `KnownFeature` (`isoManagement`), `effectiveFeatures()`, `FEATURE_NOT_ENABLED`
  (403, details `{ feature }`), optional `AccountOverride.removedFeatures` (never overlapping `features`), optional
  `AccountSummary.features` (so `Me.account.features`), `ActKind` and optional `Act.kind` (STANDARD is CENTRAL),
  optional `Obligation.clauseRefs` as `ClauseNumber[]`, and `ISO_ENTITY_TYPES` staged outside `EntityType` (README
  decision 41). The mock lists each firm's features (firm B, Second Ledger Consulting, has `isoManagement`; firm A
  none) and `PUT /__mock/firms/{firmId}/features` changes them.
- **What later packages change:** ISO-1 replaces `ISO_ENTITY_TYPES` with the v2 list (model §8) and reshapes
  `clauseRefs` to `{ standard, clauseNumber }[]`; ISO-1b joins the staged values; ISO-1c makes fields required.

## ISO-2a · M3 · Store add-on switches and the ISO library columns
- **Status:** merged (#253, migration 0036; #258, migration 0037's strict `clause_refs` check). **Needs:** ISO-0.
- **Delivers:** `account_override.removed_features text[] not null default '{}'`; `act.kind` (STATUTE | STANDARD, not
  null default STATUTE); `obligation.clause_refs jsonb not null default '[]'` in the shape `{ standard, clauseNumber }[]`
  (the repository omits it on read and refuses a non-empty value until ISO-1 reshapes the contract); both entitlement
  reads, `app_account()` (CREATE OR REPLACE in the new migration) and `platformAccounts.entitlements` /
  `accountOverrides`, return (plan ∪ override) − removed, with db tests on the tenant and operator sides, including a
  plan feature that is also removed; `account.features(tx)` in `packages/db/src/repositories/accounts.ts`, a
  features-only read of `app_account()` with no usage counts, which leaves a malformed stored flag out. It does not
  stage ISO entity types (ISO-2b does).

## ISO-7 · M11 · Gate the shell on the ISO add-on
- **Status:** merged (#254, #257). **Needs:** ISO-0.
- **Delivers:** `FeatureNotEnabled` in `lib/patterns` ("ISO management systems is not turned on for your account",
  no data, a link home); the account's features in the shell model from `Me.account.features` (missing = none);
  `RouteDef.module` accepts `'M17'` and an optional `feature`; nav and the client `[...stub]` treat a route whose
  feature is off as absent and the stub shows `FeatureNotEnabled`; the ISO sidebar group linking to
  `/c/[clientId]/iso/overview` ("ISO overview"), `iso/checklist`, `iso/documents`, `iso/risks`, `iso/objectives`,
  `iso/audits`, `iso/nonconformities`, `iso/management-reviews`, `iso/certification`; mock demo accounts have
  `isoManagement` except `MOCK_COMPANY_EMAIL`; the shell e2e test `e2e/tests/shell/iso.spec.ts` (M11's), which
  clicks every ISO item and checks the h1 and title, and checks the off page and its title as `MOCK_COMPANY_EMAIL`.
  It creates nothing under `(shell)/c/[clientId]/iso/` (M17's path); the stub says M17's pages take precedence, so
  M17's `iso/layout.tsx` gates them (#257).
- **What follows:** ISO-7b makes the mock's delegated routes agree with `/me` per demo user; ISO-6a gates
  `iso/layout.tsx` with `FeatureNotEnabled`.

## ISO-4a · M5 · Check the add-on feature on requests
- **Status:** merged (#255, #259). **Needs:** ISO-0.
- **Delivers:** `requireFeature(ctx, 'isoManagement')` reading the account's effective features on every request
  through `AuthStore.accountFeatures(firmId)` (`apps/api/src/auth/db-store.ts`), which calls M3's
  `account.features(tx)` in a short lookup transaction (no session or process cache), and finds the request by
  `ctx.requestId`, throwing 403 `FEATURE_NOT_ENABLED`; `Me.account.features`; `PendingErrorCode` dropped from
  `apps/api/src/auth/errors.ts`.
- **What follows:** ISO-4c (message for `FEATURE_NOT_READY`), ISO-4b (policy rows, `hasFeature`, readiness, unit
  scope).

## ISO-5 · M15 · Add an add-ons switch to the operator console
- **Status:** merged (#252). **Needs:** ISO-0, ISO-2a.
- **Delivers:** the Add-ons card (one switch per `KNOWN_FEATURES` entry, reason required) writing
  `PUT /accounts/{id}/override` and logging `OVERRIDE_CHANGE`; `removedFeatures` accepted and returned by the override
  API; `overrideFrom` (`apps/operator/lib/account-actions.ts`) derives `removedFeatures` as the plan features missing
  from the entitlements; `withFeature` changes only features and removedFeatures (off puts the flag in
  `removedFeatures` only when the plan has it), the "Override limits" drawer only limits and the non-add-on flags.
  Neither wipes the note: the operator API has no read of the override, so the console takes the stored note from
  the account's newest `OVERRIDE_CHANGE` operator audit event (`noteFrom`, `after.override.note`; operator audit is
  never deleted) and sends it unchanged from both. Tests: a limits save keeps a removed feature removed and the note;
  a switch keeps overridden limits and the note; turning off a plan feature works.
- **What follows:** ISO-5b (the features-changed event, plan routes, known features in the drawer, copy status).

---

## ISO-4c · M5 · Message for FEATURE_NOT_READY ahead of the contracts
- **Thread title:** "ISO-4c: a message for FEATURE_NOT_READY". **Needs:** ISO-4a.
- **Read:** plan §4.3, §5.2.
- **Paths:** `apps/api/src/auth/errors.ts`, `apps/api/src/auth/errors.test.ts`.
- **Delivers:** `FEATURE_NOT_READY` as a pending code (the way #248 added `FEATURE_NOT_ENABLED`) with the message
  "This add-on is being set up for your account. Try again in a few minutes." Nothing throws it yet (ISO-4b does).
- **Tests:** the message test, as for `FEATURE_NOT_ENABLED`; the existing "every contract code has a message" test stays
  green before and after ISO-1 lists the code.
- **Notes:** must merge before ISO-1.

## ISO-12b · M13 · Show add-ons on the Account page
- **Thread title:** "ISO-12b: add-ons on the Account page". **Needs:** ISO-0, ISO-7 (the demo users'
  `Me.account.features` in `apps/web/lib/api/mock.ts`; merged).
- **Read:** plan §4.1; `apps/web/CLAUDE.md`, `packages/ui/CLAUDE.md`.
- **Paths:** `apps/web/app/(shell)/account/`, `e2e/tests/overview/` (account page journeys, if they live there).
- **Delivers:** an Add-ons section listing every `KNOWN_FEATURES` entry with its label and description and On or Off
  from the shell model's features (`Me.account.features`, ISO-7; missing = Off), never from `getAccount`'s
  `features`, which the M0 mock fills from firm B for every demo user, `MOCK_COMPANY_EMAIL` included; and the sentence "Your PlanetPulse contact turns add-ons on or off."
  Read-only: no control changes it.
- **Tests:** component test for on, off and a missing list; e2e against the mock as a demo user with the add-on and as
  `MOCK_COMPANY_EMAIL` without it; light mode at 1280 and 375, keyboard-only, axe.

## ISO-1 · M0 · ISO contracts
- **Thread title:** "ISO-1: ISO contracts". **Needs:** ISO-0, ISO-4c. **Status:** merged as #265 (contracts 1.8.0);
  its departures, README decision 51 (a-n), are folded into plan v2.1, and its audit's findings are ISO-1a.
- **Read:** all of model.md and catalogue.md; plan §3, §4, §5.1-5.2; `docs/contracts/README.md` decisions 39 and 41.
- **Paths:** `packages/contracts/` (`src/enums.ts`, `src/primitives.ts`, `src/errors.ts`, `src/defaults.ts`,
  `src/engine-api.ts`, `src/schemas/{iso.ts (new),library.ts,tenancy.ts,context.ts,scores.ts,accounts.ts}`,
  `src/api/{iso.ts (new),endpoints.ts,workflow.ts,dashboards.ts,error-details.ts,openapi.ts}`, `src/mock/`,
  `scripts/fixtures/`, `fixtures/`, `test/`, `src/version.ts`), `docs/contracts/`.
- **Delivers (additive; contracts 1.8.0, or the next free minor):**
  - Shapes for every model §2-3 record (catalogue rows, management system, context, clause assessment, documents and
    revisions, risk items and controls, objectives and readings, programmes, internal audits and checklist items,
    certifications, external audits, findings, nonconformities with incident fields, `IsoAction`, management reviews
    with inputs and outputs, `IsoFile`/`IsoFileView` without `storageKey`), request bodies and list queries, and the
    state and action enums of every machine in model §4.
  - `ISO_ENTITY_TYPES` replaced by the v2 list (model §8), before anything stages it; new staged constants
    `ISO_NOTIFICATION_KINDS` (model §7) and `ISO_EXPORT_KINDS` (model §9). None of them joins a contract enum here.
  - `Obligation.clauseRefs` reshaped to `{ standard: ISO_9001 | ISO_14001 | ISO_45001, clauseNumber: ClauseNumber }[]`,
    still optional, unique per standard and number.
  - Endpoints for model §10 with the role matrix of plan §3.2 in `docs/contracts/endpoints.md` and `ENDPOINTS`; each
    list endpoint's notes say "AP/OW limited to their units (plan §3.3)". `Resource.unitIds?` (optional, non-empty).
  - `registerFilterShape.source` (`LAW | ISO`, optional) so `RegisterQuery`, `RegisterFilterQuery` and the register
    export get it; the same on `MyQueueQuery`, `CalendarQuery` and the vault query.
  - `ExportCreateBody` accepts the ISO kinds (once joined) with ISO list filters, not `RegisterFilterQuery`.
  - `FirmSettings.isoRisk: { significantAt: int 1-25, legalLinkMakesSignificant: boolean }` with `.default({
    significantAt: 12, legalLinkMakesSignificant: true })` on the field and the same value in
    `DEFAULT_FIRM_SETTINGS`, so firms stored without it still parse. Not editable in v1.
  - `IsoEngineApi` (a separate interface beside `EngineApi`) with the model §5 signatures, `reviewInputFigures`
    (model §5.4) included, and `PlannedIsoNotification`, `ISO_NOTIFICATION_DEDUPE_KEY`, `IsoNotificationInput`,
    `IsoReminderSchedule` and `ISO_REMINDER_SCHEDULE` in `src/defaults.ts` (model §5.3, §7). `EngineApi` and
    `PlannedNotification` do not change. The management review input view carries `sourceFigures` (model §10).
  - `DueThisWeekFilter` gains an optional `source` (`LAW | ISO`), so `PortfolioRow.dueThisWeekFilter` can say Law
    (ISO-11b, ISO-12c).
  - `FEATURE_NOT_READY` (409, details `{ feature }`) in `ErrorCode`; `ERROR_DETAILS.INVALID_TRANSITION` gains a member
    `{ entity: IsoEntityType, from: string, action: string }`.
  - Event `account.features_changed { accountId, added: FeatureFlag[], removed: FeatureFlag[] }` in
    `docs/contracts/events.md` "Accounts" (producer M15, consumer M9); ISO record events only where a consumer needs
    them (none in v1). Operator `Account.isoCatalogueCopiedAt` (optional `Instant | null`).
  - Fixtures: ISO data for firm B's Northwind Foods Group (the client the web mock maps to the demo client;
    `apps/web/lib/api/mock-delegate.ts` loads only firm B), in its own generated file (`scripts/fixtures/
    firm-b-iso.ts` → `fixtures/firm-b.iso.json`) merged into firm B by the mock store: a management system with
    9001 + 14001 + 45001, catalogue rows, clause assessments in every state, documents with revisions, risk items of
    every kind, objectives with readings, a programme with an audit and findings, an external audit, NCs in every
    state including an incident, actions on every subject, a management review, a certificate, and the STANDARD acts
    with a few activity instances. Firm A (the golden register) gets no ISO rows. Existing fixture counts
    (`test/fixtures.test.ts`) and every web unit and e2e test against the mock stay green unchanged; if a shared list
    would change a count they assert, keep that STANDARD data out of it and say so in the PR.
  - Mock handlers for every ISO endpoint, enforcing the flag as the real API does: with the firm's `isoManagement`
    off every `/iso` route answers 403 and STANDARD instances leave the instance, calendar, approvals and dashboard
    responses. An `x-mock-features` request header (comma-separated, empty = none) overrides the firm's features for
    that request, so the web mock can play a demo user without the add-on (ISO-7b). With it on, the mock's portfolio,
    overview, breakdown, report and certificate responses still count STATUTE-act instances only (plan §4.6);
    `PortfolioRow.dueThisWeekFilter` carries `source: 'LAW'`; the instance list, `/me/approvals`, `/me/tasks`, vault
    and calendar handlers honour `source` (`LAW`, `ISO`, absent = both). This lets ISO-11c's and ISO-12c's e2e match a
    number to its filtered list.
  - `domain-model.md`, `endpoints.md`, `events.md`, `api-conventions.md`, `openapi.json`, README decisions, CHANGELOG.
- **Tests:** schema tests per shape (guards from model §3-4 that a schema can express: exactly one subject on
  `IsoAction`, `IsoFile` and `AuditFinding`; required-when rules, including `dispositionAuthorisedById` when
  `disposition` is set, the incident `type`/`source`/`outcome`/`lostDays` rules and the climate rationale), mock tests
  for on, off and the header, fixture tests, OpenAPI lint.

## ISO-1a · M0 · ISO contract fixes from the ISO-1 audit
- **Thread title:** the ISO-1 thread ("Build ISO contracts") continues, as #271. **Needs:** ISO-1. **Status:** merged
  (#271).
- **Read:** the ISO-1 audit on #265; plan §3.2; model §1.9, §3.4, §3.7, §3.9-3.11, §4.1, §4.5, §5.1.
- **Paths:** `packages/contracts/`, `docs/contracts/`.
- **Delivers (patch bump, contracts 1.8.1):**
  - **One action per route** (Medium 1, README decision 51 o): the NC PATCH is `isoNc.work` (CA, OW own); a new
    `POST .../nonconformities/{id}/reassign` is `isoNc.reassign` (FA, CO, CA) for `ownerId`, `approverId`, `dueOn`,
    `effectivenessDueOn`, `severity` and the incident `outcome`, always with a `reason`; the management review PATCH
    is `isoReview.write` (attendees, minutes; AP and OW as chair), and a new `POST .../management-reviews/{id}/replan`
    is `isoReview.plan` (FA, CO, CA) for standards, `plannedOn` and chair while PLANNED. 119 routes. A test that no
    endpoint lists more than one action, and the stub `can()` pinned: FA and CO out of `isoNc.work`, the NC owner (an
    OWNER) out of `isoNc.reassign`, the chair out of `isoReview.plan`.
  - **The no-action guards** (Medium 2): `severity` and the incident `outcome`, which SUBMIT_NO_ACTION reads, change
    only on the reassign route, with a reason, while OPEN or ROOT_CAUSE_FOUND (`409 INVALID_TRANSITION` after);
    `lostDays` stays on the PATCH while the outcome is LOST_TIME and moves with the outcome otherwise. Neither changes
    on the reassign route for an NC raised from a finding (`400 VALIDATION`), whose severity follows the finding's
    type: the internal and external finding updates refuse a MAJOR_NC/MINOR_NC move once the NC has left OPEN or
    ROOT_CAUSE_FOUND (`409 INVALID_TRANSITION`) and when the NC's owner makes it (`403 FORBIDDEN`). Model §3.9-3.11.
  - **`objectiveProgress`** (Medium 3, decision 51 r) takes `createdOn: LocalDate` and `{ fyStartMonth }`, not
    `createdAt` (model §5.1).
  - **Lows:** the extra stored rules declared (decision 51 q: `rootCauseMethod` from ROOT_CAUSE_FOUND on, the lead not
    also in `auditorIds`, NC `dueOn` not before `reportedOn`, `RiskItem.condition` on ASPECT and HAZARD; Low 1);
    decision 51 m reworded, with no new field (Low 2); the `Resource.unitIds` doc says to leave it out for an
    all-units record (Low 4); the reason rule (decision 51 p, model §1.9; Low 5); a test pinning `iso.catalogue.json`
    to its generator (Low 6); `x-mock-features` on every mock route, sign-in included (Low 7, which ISO-7b needs);
    409 `FEATURE_NOT_READY` beside 403 `FEATURE_NOT_ENABLED` on every gated operation in the OpenAPI (Low 8). Low 3
    (`FirmSettings.isoRisk` on stored rows) is ISO-2b's (#272, migration 0038).
  - The README decisions, CHANGELOG, endpoints.md and `iso-mock.md` updated to match.
- **Tests:** the one-action test and the pinned `can()`; the reassign route per role, its severity and outcome window
  and its refusal for a finding's NC; a finding's MAJOR_NC/MINOR_NC move refused after ROOT_CAUSE_FOUND and for the
  NC's owner; a chair refused on the replan route; each `reasonWith` field refused without a reason;
  `objectiveProgress` stand-in at a day boundary in the client's time zone; sign-in with and without the header; the
  catalogue test.
- **Notes:** ISO-3 and ISO-7b merge `main` after ISO-1a before marking ready; ISO-1b and ISO-4b start after it.

## ISO-1a2 · M0 · Stored review figures and the ISO-1a audit fixes (contracts 1.8.2)
- **Thread title:** the ISO-1 thread ("Build ISO contracts") continues. **Needs:** ISO-1a. Like ISO-1a, it does not
  count toward plan §5.4's five threads.
- **Read:** the ISO-1a audit on #271; ADR M16-0003; model §1.7, §3.13, §4.5, §5.4, §8, §10; plan §3.3.
- **Paths:** `packages/contracts/`, `docs/contracts/`.
- **Delivers (patch bump, contracts 1.8.2; #284):**
  - `ReviewInput` gains `sourceFigures`, `figuresStoredAt` and `figuresEngineVersion`, set together or not at all, each
    defaulting to null so rows M3 stores before ISO-2g still parse. `ReviewInputView`'s `sourceFigures` is the stored
    copy for HELD and CLOSED, computed as of the client-local today for PLANNED, and null for CANCELLED and `MANUAL`
    rows, with the ids cut for the reader; its `figuresStoredAt` is set exactly when it is the stored copy. The engine
    version stays off the view: the pack reads it from the row. `ReviewFigure` and `ReviewInputFigures` move to
    `schemas/iso.ts`.
  - `ReviewFigureData` types `data` per source: `createdOn` and `archivedOn` on every row, statutory instances included;
    `subject` and `doneOn` on actions; `reportedOn` on NCs; `contextChanges`, `ratingChanges` and `notEffectiveSteps` as
    `{ entityId, on }` days the caller builds from the events model §5.4 names; INCIDENTS the client's time zone. No
    `held` flag and no general list of changes (#271 audit Medium 1). `IsoEngineApi.reviewInputFigures` keeps 1.8.1's
    wide `data`, because ISO-3's engine (#270) declares its own per-source types and `satisfies IsoEngineApi`; the typed
    form is `TypedReviewInputFigures`, with a type test that a function typed that way satisfies 1.8.2. ISO-3b moves the
    engine onto it, and ISO-1c narrows the signature.
  - The mock stores the figures at RECORD_HELD over the whole system, its event carrying the values (no ids) and the
    engine version, and returns that copy for HELD and CLOSED; the fixture's held review gets its figures at load. The
    rebuild from the audit trail is gone, and model §5.4's date rules replace it. RECORD_HELD refuses a `heldOn` after
    the client-local today. A replan that adds a standard back makes a new live row, as ISO-2g's partial keys do.
  - The rest of the #271 audit: Medium 2 becomes model §5.4's creation-day rule (an NC counts from the later of its
    creation day and `reportedOn`); Low 3 becomes its archive-day rule; Lows 4 and 5 no longer apply (only held reviews
    set `since`, and cancellation is read as it is now); Low 6's local-midnight test moves to the event-day lists; Low 7
    (README version line, and the CHANGELOG on the patch bump), Low 8 (decision 51 p: the M13 and M17 forms send only
    changed fields) and Info 9 (the mock's idempotency key includes the path).
  - Left to ISO-1a3, by agreement: step days for backdated dates, PREVIOUS_ACTIONS by settled day, no figures before the
    system's creation, `REVIEW_FIGURE_KEYS`, and RISKS kinds and AUDIT_RESULTS findings by standard.
- **Tests:** figures unchanged after later edits; the ids cut for a unit-limited reader while the values stay the
  system's; null for CANCELLED; a backdated and a same-day `heldOn`; an event across local midnight; the residual clear
  is not a re-rating; statutory instances on a backdated `heldOn`; RECORD_HELD against the client's today; a
  `TypedReviewInputFigures` function satisfies `IsoEngineApi`; the OpenAPI lint and the regeneration test.

## ISO-2b · M3 · Stage ISO enum values and give the send log an ISO subject
- **Thread title:** "ISO-2b: staged ISO enum values and the ISO send key". **Needs:** ISO-1, ISO-2a.
  **Status:** merged (#272).
- **Read:** plan §5.1; model §7, §8, §9; `packages/db/CLAUDE.md`.
- **Paths:** `packages/db/` (a new migration, `migrations/meta/`, `src/schema/enums.ts`, `src/schema/ops.ts`,
  `src/repositories/ops.ts` (`NotificationSend`, `notificationSends`), tests).
- **Delivers (one migration on existing types and an existing table, in its own PR):**
  - `ALTER TYPE ... ADD VALUE` for every value in `ISO_ENTITY_TYPES` (into `entity_type`), `ISO_NOTIFICATION_KINDS`
    (into `notification_kind`) and `ISO_EXPORT_KINDS` (into `export_kind`); the `new Set([...X.options, ...])` unions
    in `enums.ts` built from those contract constants, with a comment; the "ahead" rows of
    `test/schema.test.ts`.
  - `notification_send`: nullable `iso_subject_type entity_type` and `iso_subject_id uuid`; a check that `instance_id`
    and `iso_subject_id` are not both set; unique index `notification_send_iso_subject_key` on `(firm_id,
    iso_subject_type, iso_subject_id, kind, send_date, recipient_id) where iso_subject_id is not null and event_id is
    null`; `notification_send_digest_key` recreated with `and iso_subject_id is null` added to its predicate. Compare
    kinds as text in any check (as 0030 and 0034 do), so the new enum values and the constraint apply in one run.
  - In `src/repositories/ops.ts`: `NotificationSend` gains optional `isoSubjectType` (an ISO entity type) and
    `isoSubjectId` (both or neither, never with `instanceId`), and its `kind` accepts the `ISO_NOTIFICATION_KINDS`
    values until ISO-1b joins them (as the `enums.ts` unions do). The private `sendKey()` also matches on the ISO
    subject (`iso_subject_id is null` for instance, digest and account sends), so `notificationSends.claim`,
    `markSent` and `markFailed` touch only that subject's row, and one ISO send never marks another subject's row.
    `listDone` returns the subject. `listDoneDigests` adds `iso_subject_id is null and kind = 'CONSULTANT_DIGEST'`
    (its port says it lists digest outcomes), so an ISO reminder never counts as that day's digest
    (`apps/api/src/jobs/digest.ts` skips consultants it returns). `claimSend`, `markSent`, `markFailed`,
    `listDoneSends` and `listDoneDigests` are M9's `FirmTx` names in `apps/api/src/jobs/postgres-store.ts`; ISO-10c
    passes the subject through them.
- **Tests:** schema test with the staged values; drift test green; db tests: two ISO subjects due the same day for one
  recipient claim two rows; `markSent` on one of them leaves the other PENDING and `claim` reports each row's own
  state; a digest row and an ISO row for the same recipient, kind and day do not collide; an ISO send to a consultant
  on digest day leaves `listDoneDigests` without that consultant; the check refuses a row with both an instance and an
  ISO subject.

## ISO-3 · M4 · ISO engine functions and transition tables
- **Thread title:** "ISO-3: ISO engine". **Needs:** ISO-1, ISO-1a (started before ISO-1a; merges `main` after it,
  before marking ready, so `satisfies IsoEngineApi` sees `objectiveProgress` with `createdOn` and `{ fyStartMonth }`,
  and its tables hold the plan v2.2 guards).
- **Read:** model §4, §5, §7; `packages/engine/CLAUDE.md`; `IsoEngineApi` in `packages/contracts/src/engine-api.ts`;
  `docs/contracts/iso-mock.md` ("Stand-ins for M4 formulas" and the guards it lists by area).
- **Paths:** `packages/engine/src/{iso-score.ts,iso-status.ts,iso-notifications.ts,iso-review.ts,index.ts,version.ts}`,
  their tests, `docs/adr/M4-NNNN-iso-engine-rules.md` (next free M4 number).
- **Delivers:** every function in model §5 (`reviewInputFigures` in §5.4 included) and every transition table in
  model §4 with the maker-checker rule of its preamble, exported as one object that `satisfies IsoEngineApi`;
  `ENGINE_VERSION` bumped; the ADR records the fixed 5×5 scale, the significance rule and its defaults, readiness
  weights, the certification gates (including RISKS) and their 12-month window, what "covered" means for audits,
  due-soon and overdue rules for NCs, actions, reviews and certificates, the certification cycle, and the reminder
  schedule of model §7 (`ISO_REMINDER_SCHEDULE`, ISO-1). The timing functions take `{ dueSoonDays }`
  (`FirmSettings.dueSoonDays`, model §5.2); `objectiveProgress` counts from `createdOn`, a `LocalDate`, by the
  client's FY (model §5.1). The model §4.1 guards as of plan v2.2: ADD_ROOT_CAUSE needs `rootCauseMethod`, RAISE
  refuses a `dueOn` before `reportedOn` (README decision 51 q), each with a refused-arrow test.
  The mock's stand-ins (`docs/contracts/iso-mock.md`, "Stand-ins for M4 formulas") for objective progress, the
  certification cycle, programme coverage, the overview (its 12-month and 90-day windows, and its POLICY 5.2.x and
  OBJECTIVES readings of the certification gates) and NC status are the starting point: the ADR says, for each, that
  the engine keeps it or how it differs, and a difference goes to the coordinator for an M0 mock change. The review
  figures' `since` is the caller's (model §5.4), so M16 rules on that stand-in, not M4.
- **Tests:** explicit dates and values for every function, including month ends, 29 February and FY boundaries; every
  arrow and every refused arrow of every machine; plan §7 items 5 and 6; a NOT_AUDITED row covers nothing; a row with
  no unit, in an audit whose unit list is empty, covers its clause but no unit; `reviewInputFigures` per source and
  for a system's first review (`since` = its creation date); `planIsoNotifications` for a repeating overdue review and
  two subjects of one kind for one recipient; a certificate not yet issued (no `expiresOn`) has an empty cycle;
  DUE_SOON at the firm's `dueSoonDays`. Coverage 100% on `iso-score.ts` and `iso-status.ts` (the `*{status,score}*`
  threshold in `vitest.config.mjs` applies by name), 95% elsewhere.
- **Plan v2.5:** held-review figures are stored at RECORD_HELD (model §3.13), so `reviewInputFigures` keeps reading
  records as they are now and builds no history. ISO-3 merged (#270) on the contracts 1.8.1 signature with its own
  per-source types; ISO-3b moves it onto the contract's and adds model §5.4's date reads.

## ISO-3b · M4 · As-of date reads for review figures
- **Thread title:** the ISO-3 thread ("Build the ISO engine functions") continues. **Needs:** ISO-3, ISO-1a3.
- **Read:** model §3.13, §5.4; ADR M16-0003; `docs/adr/M4-0001-iso-engine-rules.md`.
- **Paths:** as ISO-3.
- **Delivers:** `reviewInputFigures` typed as the contract's `TypedReviewInputFigures`, taking `ReviewFigureData` (the
  engine's own per-source types go), with model §5.4's date rules: the creation day (for an NC, the later of `createdOn`
  and `reportedOn`); `archivedOn` and `closedOn` after `asOf`; for audits, actions, objective closes and the climate
  decision, the later of the entered date and the step day (the latest step when there are several), and an action's
  settled day; an incident by the later of its `occurredAt` day and its NC's counting day, and a finding by the later of
  its audit's day and its own creation day, whether or not its audit counts in the window (`incidentCounts` keeps the
  overview's `occurredAt` rule; the review places incidents before grouping them); readings created by `asOf`; the three
  event-day lists for re-rated, changed and not-effective counts; PREVIOUS_ACTIONS done and cancelled in the window
  only; `correctiveActionsOverdue` only for actions whose NC is open on `asOf` (not CANCELLED, and `closedOn` null or
  after `asOf`). The caller picks risk kinds by input key and findings by standard (model §5.4), so the engine counts
  what it is given. Every key it emits is in `REVIEW_FIGURE_KEYS`. No rebuild code. ADR M4-0001 item 18 and the
  `iso-review.ts` header say the caller passes the system's records for the input's standards with no unit scope (plan
  §3.3 exception), archived ones included. `ENGINE_VERSION` bumped (`packages/engine/CLAUDE.md` rule 4), since stored
  figures name the version that produced them.
- **Tests:** per source with an `asOf` earlier than the data's present (a record created, archived, closed or done after
  `asOf`; an NC reported before `asOf` but raised after it; an external audit recorded HELD after `asOf` with `endOn`
  before it; an action settled before `since`; an objective closed after `asOf` with `closedOn` before it; an incident
  that occurred before `since` on an NC raised after it, counted; an external finding created after `since` on an audit
  placed before it, counted; an overdue OPEN action on a cancelled NC, not counted); the engine's keys match
  `REVIEW_FIGURE_KEYS`; coverage as ISO-3.

## ISO-7b · M11 · Mock features per demo user for ISO screens
- **Thread title:** "ISO-7b: mock add-on state per demo user". **Needs:** ISO-1, ISO-1a, ISO-7 (started before
  ISO-1a; it needs ISO-1a's sign-in fix, so it merges `main` after ISO-1a before marking ready).
- **Read:** plan §4.4; ISO-1's mock notes.
- **Paths:** `apps/web/lib/api/mock.ts`, `apps/web/lib/api/mock-delegate.ts`, their tests, `e2e/tests/shell/`.
- **Delivers:** the delegate forwards the signed-in demo user's `Me.account.features` to M0's mock as
  `x-mock-features`, so `/me` and every delegated route agree: as `MOCK_COMPANY_EMAIL`, `/iso` routes answer 403 and
  register lists carry no STANDARD instances; as any other demo user, ISO data shows.
- **Tests:** delegate unit test for the header; shell e2e for both users, including a direct `/c/{clientId}/iso/...`
  URL showing the not-turned-on page.

## ISO-12a · M13 · Audit trail words for ISO entity types
- **Thread title:** "ISO-12a: audit trail words for ISO records". **Needs:** ISO-1, ISO-12b.
  **Status:** merged (#268).
- **Read:** plan §5.1; model §8.
- **Paths:** `apps/web/app/(shell)/c/[clientId]/audit/`.
- **Delivers:** `ENTITY` in `audit-model.ts` keyed `Record<EntityType | IsoEntityType | 'account', string>` with
  plain words for every v2 ISO entity type ("Management system", "Nonconformity", "ISO action", ...), so the map stays
  complete before and after ISO-1b joins them. Field labels for the ISO fields that audit events carry, where the
  page labels fields.
- **Tests:** the model's exhaustiveness test; a rendered ISO event.
- **Notes:** must merge before ISO-1b.

## ISO-12d · M13 · ISO states in words on the audit trail page
- **Thread title:** "ISO-12d: audit trail states in words". **Needs:** ISO-12a. **Status:** merged (#275).
- **Read:** model §4.7, §8; `packages/ui/spec/status-language.md`; the ISO-12a audit on #268 (its two Info notes).
- **Paths:** `apps/web/app/(shell)/c/[clientId]/audit/`.
- **Delivers:**
  - The page's change lines show a state or code in words, never as the code. `state` and `status` mean different
    enums on different records, so the page picks the word map by the event's entity type and field:
    - an ISO record's `state` and `status`, a nonconformity's `severity` and a checklist item's `result` in model
      §4.7's words ("State: Root cause found → Actions planned"); a risk item's `severity` is a number and stays one;
    - an instance's `workflowState` as "Open", "Awaiting approval" (the word of `packages/ui/spec/status-language.md`),
      "Sent back", "Approved" and "Not applicable";
    - a person's `status` (`PersonStatus`) by model §4.7's rule ("Status: Invited").
  - A test pins "(as delegate)" on an instance event: a TRANSITION whose `after` has `workflowState: 'APPROVED'` and
    `delegated: true` reads "Approved an instance (as delegate)". The API already writes `delegated` when a client
    admin approves or sends back in the approver's place, so since ISO-12a existing instance rows say so (#268 audit,
    Info 1).
- **Tests:** each word map against every value of its contracts enum; a rendered ISO state change, instance state
  change and person status; the delegate test above.
- **Notes:** display only; no compliance logic.

## ISO-11c · M12 · Source filter on register, approvals, calendar and evidence screens
- **Thread title:** "ISO-11c: Law and ISO source filter". **Needs:** ISO-1, ISO-7b.
- **Read:** plan §4.4-4.6; `docs/adr/M12-0001-register-url-state-and-saved-views.md`.
- **Paths:** `apps/web/app/(shell)/c/[clientId]/{register,approvals,calendar,evidence}/`, `e2e/tests/register/`.
- **Delivers:** a Source filter (Law, ISO, both) in the URL state like the other filters, on the register, approvals,
  calendar and evidence vault, shown only when the shell model has `isoManagement`; saved views keep it; with the
  add-on off the filter is absent and a stale `source` in the URL is ignored. No compliance logic: rows come from the
  API.
- **Tests:** unit tests for the URL state; e2e against the mock as a user with the add-on (filter narrows to ISO
  activities) and as `MOCK_COMPANY_EMAIL` (no filter, no ISO rows); light mode at 1280 and 375, keyboard-only, axe.

## ISO-6a · M17 · ISO screens 1: gate, overview, systems, checklist, documents, certification
- **Thread title:** "ISO-6a: ISO screens, part 1". **Needs:** ISO-1, ISO-7, ISO-7b.
- **Read:** plan §2-4; model §1.9, §3.1-3.4, §3.8, §4.2, §4.4, §4.6, §4.7, §5.1, §6, §10; catalogue §4;
  `apps/web/CLAUDE.md`,
  `packages/ui/CLAUDE.md`; `docs/contracts/iso-mock.md` (the rules the mock enforces, which the e2e journeys meet).
- **Paths:** `apps/web/app/(shell)/c/[clientId]/iso/` (`layout.tsx`, `overview/`, `checklist/`, `documents/`,
  `certification/`, `actions/` placeholder only if needed), `e2e/tests/iso/`.
- **Delivers:**
  - `iso/layout.tsx` is required (audit of #254: a real `page.tsx` overrides M11's `[...stub]`, so without it an ISO
    page would render while the add-on is off). It gates every ISO page: feature off in the shell model → M11's `FeatureNotEnabled` and no data
    loaded; an API answer of 409 `FEATURE_NOT_READY` → a "being set up" state; 403 `FEATURE_NOT_ENABLED` from any
    call → `FeatureNotEnabled`.
  - Overview (`iso/overview`): per standard, clause readiness beside the certification gates (each unmet gate links to
    what is missing), climate warnings, NC and action counts, programme coverage, incidents, certificate expiry and
    the next management review; every number links to its filtered list; a "My ISO actions" card linking to
    `iso/actions`.
  - Systems set-up (inside overview or checklist, by the design): standards, scope, units, context items, the climate
    decision.
  - Every step button comes from the view's `allowedActions` (model §10); a screen never works out who may act.
  - Every state and code reads in model §4.7's words (pills, filters, lists and record pages), never as the code; the
    words are tested against every value of each contracts enum shown.
  - A new owner or approver and a moved date (a checklist row's owner; a document's owner, approver and review date;
    an external audit's response date) ask for a reason (model §1.9).
  - Checklist: rows per assessable clause, owner, notes, files, N/A request (with its reason) and decision only where
    allowed, readiness. Standards can be added to a system, never removed (model §3.1).
  - Documents: list (status, current revision, review date), detail with revision history (superseded marked),
    draft, submit, approve, send back, review without change, make obsolete, external editions, files.
  - Certification: certificates (one being pursued has no number, issue or expiry date yet, model §3.8) and external
    audits with their findings, recommendation and response date. An external document's recorded edition shows its
    issuer, not an approver (model §3.4).
  - Keep M11's `e2e/tests/shell/iso.spec.ts` (ISO-7) green; M17 cannot edit it. Every ISO page's h1 is its sidebar
    label (`ISO overview`, `Checklist`, `Documents`, `Risks`, `Objectives`, `Audits`, `Nonconformities`,
    `Management reviews`, `Certification`) and its title is `<label> · <client name>`. With the feature off, the
    layout renders `FeatureNotEnabled` and every ISO page's `generateMetadata`, record pages included, loads nothing
    and returns `Not turned on · <client name>`; `iso` and an unknown `iso/...` path still show the off page as the
    test expects. If a page needs other words, the coordinator has M11 change its test first.
- **Tests:** M11's shell ISO test stays green; component tests for every gate state; e2e against the mock for checklist N/A request and approval, a
  document revision from draft to approved, and the off state as `MOCK_COMPANY_EMAIL`; light mode at 1280 and 375,
  keyboard-only, axe on every page; loading, empty, error, no-permission, not-turned-on and being-set-up states.

## ISO-2c · M3 · Library guards, clause references and the catalogue marker
- **Thread title:** "ISO-2c: library guards and the ISO catalogue marker". **Needs:** ISO-2b.
  **Status:** merged (#273).
- **Read:** plan §4.2-4.4; catalogue §1-2; `packages/db/CLAUDE.md`.
- **Paths:** `packages/db/`.
- **Delivers (migrations on existing tables, own PR):**
  - `act.kind`: a BEFORE UPDATE trigger refuses any change, whatever the role; a restrictive insert policy lets
    `kind = 'STANDARD'` through only under `app_system_job()`; `act_name_key` becomes `(firm_id, kind, name)` among
    non-archived rows.
  - `obligation.clause_refs` read and written in the ISO-1 shape (the ISO-2a refusal of non-empty values goes).
  - `firm.iso_catalogue_copied_at timestamptz` and `app_mark_iso_catalogue_copied()` (SECURITY DEFINER, owned by
    `canopy_platform`, system context only, sets once, returns true when it set it; works in TRIAL and ACTIVE);
    `accountJobs.markIsoCatalogueCopied(tx)`.
  - The app-side read `account.isoCatalogueCopiedAt(tx): Promise<string | null>` in
    `packages/db/src/repositories/accounts.ts`, which reads `firm.iso_catalogue_copied_at` for `app_firm_id()` like
    `account.libraryCopied` (no usage query). M5 (ISO-4b) and M9 (ISO-10a-c) use it beside `account.features(tx)`.
    `app_account()` gets no marker column (adding a result column would mean dropping and recreating it, with its owner
    `canopy_platform` and 0020's REVOKE/GRANT re-applied). `platformAccounts` returns `isoCatalogueCopiedAt` for the
    console.
  - 0036 repeats the feature formula in SQL in `app_account()` and in `platformAccounts.entitlements`; both move onto
    `canopy_effective_features(plan text[], added text[], removed text[]) RETURNS text[]` (IMMUTABLE, reads no table,
    sorted and distinct); `app_account()` by CREATE OR REPLACE with unchanged result columns, which keeps its owner and
    grants.
- **Tests:** a consultant context cannot insert a STANDARD act; no context can change `act.kind`; a STATUTE and a
  STANDARD act may share a name; the marker sets once, refuses outside the system context, and works in TRIAL and
  ACTIVE; `account.isoCatalogueCopiedAt` returns null before the mark and the time after it, in a staff, client and
  system context; the two feature reads agree for a plan, an added and a removed feature.

## ISO-11e · M10 · Default branch in the export builder ahead of new export kinds
- **Thread title:** "ISO-11e: the export builder takes new kinds". **Needs:** ISO-1.
- **Read:** plan §5.1 step 3a; `apps/api/CLAUDE.md`.
- **Paths:** `apps/api/src/modules/reports/service.ts` and its tests.
- **Delivers:** `buildFile`'s `switch (job.kind)` gets ``default: throw new Error(`No file builder for
  ${String(job.kind)}`)``, so the end of the function stays unreachable for tsc when new kinds join `ExportKind`
  and a job of a kind M10 does not build ends FAILED. `createExport` refuses any kind outside the six it builds
  (`REGISTER_XLSX`, `ACT_REPORT_XLSX`, `DEPARTMENT_REPORT_XLSX`, `OVERDUE_REPORT_XLSX`, `CERTIFICATE_PDF`,
  `CLIENT_ARCHIVE_ZIP`) with `400 VALIDATION`, so ISO-1b can join `ISO_EXPORT_KINDS` before ISO-11d builds them.
- **Tests:** existing kinds build unchanged; a kind from `ISO_EXPORT_KINDS` (ISO-1) is refused at create and fails
  the build branch.
- **Notes:** must merge before ISO-1b, as #212 needed M10's default branch before `CLIENT_ARCHIVE_ZIP` joined.

## ISO-1b · M0 · Join the staged ISO enum values
- **Thread title:** "ISO-1b: ISO values join the contract enums". **Needs:** ISO-1a, ISO-2b, ISO-12a, ISO-11e.
- **Paths:** `packages/contracts/`, `docs/contracts/`.
- **Delivers (patch bump):** `ISO_ENTITY_TYPES` join `EntityType`, `ISO_NOTIFICATION_KINDS` join `NotificationKind`,
  `ISO_EXPORT_KINDS` join `ExportKind` (the staged constants stay as subsets); `satisfies Record<ExportKind, string>`
  in the mock's dashboards handler updated; ISO audit-event fixtures; CHANGELOG and README decision.
  `ExportCreateBody.kind` is `ExportKind`, so it takes the ISO kinds once they join, and its filter check already
  picks `ISO_EXPORT_FILTERS[kind]` through `exportFilterQuery(kind)` (README decision 51 n): no schema changes there.
- **Tests:** enum tests; the db schema test, the web typecheck and the apps/api typecheck stay green (they already
  handle the values: ISO-2b, ISO-12a, ISO-11e).

## ISO-1a3 · M0 · Review figures: step days, figure keys, nothing before set-up, withheld incidents
- **Thread title:** the ISO-1 thread ("Build ISO contracts") continues, after ISO-1b. **Needs:** ISO-1a2, ISO-1b. Like
  ISO-1a, it does not count toward plan §5.4's five threads.
- **Read:** ADR M16-0003; model §3.13, §5.4, §8; plan §3.3; the #284 audit (Infos 1-3); the #291 audit (Low).
- **Paths:** `packages/contracts/`, `docs/contracts/`.
- **Delivers (patch bump):**
  - `ReviewFigureData` gains the client-local day of the step that set an entered date or settled a record (model §5.4):
    internal audits (REPORT), external audits (RECORD_HELD), actions (COMPLETE or CANCEL, the settled day), objectives
    (their close) and the climate decision (the event that set it), the latest when there are several, on the row or as
    event-day lists, as the thread chooses; and each finding's creation day.
  - `REVIEW_FIGURE_KEYS`: for each source, every figure key the engine emits, the table its ids name (none for a score),
    and whether its value is the number of its ids (not so for `lostDays`, `verifiedNotEffective` or a score). Keys are
    only ever added, and a key whose meaning changes gets a new one, so stored figures stay legible (9001 7.5.3). M17
    and M10 word every listed key, and ISO-2h's `isoVisibleIds` takes the tables from it.
  - `ReviewInputView` gains `figuresWithheld` (boolean): true only on an INCIDENTS row read by an approver or owner
    whose units do not cover every unit of the system (a system with no units covers every unit of the client) and who
    is neither the review's chair nor an attendee; then `sourceFigures` and `figuresStoredAt` are null (model §3.13
    item 4, plan §3.3).
  - The mock: a backdated audit, action, objective close or climate decision counts by the later of its entered date and
    its step day; an incident by the later of its `occurredAt` day and its NC's counting day; a finding by the later of
    its audit's day and its own creation day, whether or not its audit counts in the window; PREVIOUS_ACTIONS counts
    DONE and CANCELLED actions by their settled day inside the window; RISKS reads the kinds the input's key reads
    (model §5.4); AUDIT_RESULTS counts a finding only when its clauses' standards overlap the input's; RECORD_HELD
    stores nothing for a review held before its system's `createdOn`, and a HELD or CLOSED row without a stored copy
    shows null (the fixture's held review follows whichever rule its dates meet); `correctiveActionsOverdue` counts only
    NCs open on `asOf`; INCIDENTS rows withheld as above; the fixture's stored figures take a stable `figuresStoredAt`
    with a tie-break for two held reviews on one day (#284 audit Infos 1 and 3). `docs/contracts/iso-mock.md` and the
    **Scope.** paragraph of `endpoints.md` §10 (the review figures' exception to unit scope and its limit at incidents,
    plan §3.3) follow.
- **Tests:** an external audit recorded HELD after a review, with `endOn` before it, counts in the next review, and so
  does an external finding entered after a review that counted its audit; an incident that occurred before a review's
  `heldOn` and was raised after that review was recorded counts in the next one; an objective closed after a review was
  recorded, with `closedOn` before its `heldOn`, counts as achieved or not achieved in the next one; an action settled
  before `since` is not counted again; an overdue action on a closed NC is not counted; a 9001-only input counts no
  ASPECT or HAZARD item and no finding on a 14001 clause; in a 14001 review `SIGNIFICANT_ASPECTS` counts no RISK or
  OPPORTUNITY and `RISKS_AND_OPPORTUNITIES` no ASPECT; an owner of one of two units who is not on the review gets the
  INCIDENTS row withheld, while the chair and an attendee from that unit, and a client admin, see it; a review held
  before its system's creation stores nothing; every key the mock emits is in `REVIEW_FIGURE_KEYS`.

## ISO-16 · M8 · Import matches and creates STATUTE acts only
- **Thread title:** "ISO-16: imports never touch ISO standard acts". **Needs:** ISO-2c.
- **Read:** catalogue §2; `packages/importer/CLAUDE.md`.
- **Paths:** `apps/api/src/modules/imports/` (the act list in `service.ts` and the commit's act lookup and create),
  `packages/importer/` only if the analysis needs it.
- **Delivers:** STANDARD acts are left out of the names analysis knows and out of the commit lookup; acts the commit
  creates are STATUTE.
- **Tests:** a register Act named like a STANDARD act (`ISO 14001 environmental management`) creates a STATUTE act
  beside it; golden counts unchanged; re-import idempotent.

## ISO-5b · M15 · Features-changed event and copy status in the console
- **Thread title:** "ISO-5b: tell the app when an account's features change". **Needs:** ISO-1, ISO-2c, ISO-5.
- **Read:** plan §4.1-4.3; `apps/api/src/platform/CLAUDE.md`.
- **Paths:** `apps/api/src/platform/` (`db-lifecycle.ts`, `db-accounts.ts`, `accounts.ts`, tests), `apps/operator/`.
- **Delivers:**
  - `account.features_changed { accountId, added, removed }` written through `platform_record_account_event` (the
    trail's `account.event`, as `account.plan_changed` is) in the same transaction, only when the effective features
    change: from `PUT /accounts/{id}/override`, from `POST /accounts/{id}/plan`, and from `PUT /plans/{code}` once for
    each account on that plan whose features change (with an account trail entry for each).
  - The override PUT sets a `KNOWN_FEATURES` flag only when the body names it: in `features` (on) or in
    `removedFeatures` (off). A known flag named in neither list keeps its stored state (the drawer's case). ISO-5b
    changes the console switch (`withFeature`) so it always names the flag it changes: on puts it in `features` and
    takes it out of `removedFeatures`; off takes it out of `features` and puts it in `removedFeatures`, whether or
    not the plan includes it. A `removedFeatures` entry the plan lacks keeps the flag off if a plan edit later adds
    it. The "Override limits" drawer's free-text features field neither shows nor sends known features (ISO-5
    already does this in the console; the server rule makes it hold for any caller).
  - The account page shows "ISO set up" with the copy time (`isoCatalogueCopiedAt`) when the feature is on.
    `platformAccounts` records carry it from ISO-2c (#273), but `accountOf` in `apps/api/src/platform/accounts.ts`
    builds the operator `Account` field by field and drops it today, so ISO-5b copies it across.
  - The page flags "ISO set-up has not finished" only for a TRIAL or ACTIVE account whose copy is still missing 15
    minutes after the later of the latest switch-on and the account's latest `account.status_changed` into TRIAL or
    ACTIVE. The marker sets nothing in any other status (ISO-2c), so an account switched on while PROVISIONING or
    SUSPENDED is not flagged until it can be copied.
- **Tests:** per route: switch on and off for a plan with and without the flag (one event, correct added/removed);
  no event when nothing changes; a plan edit emits one event and one trail entry per affected account; a limits save
  keeps a removal and the note; switch off on a plan without the flag turns it off, and a later limits save keeps it
  off; the copy-status display, with no flag for a SUSPENDED account and a flag counted from a resume.

## ISO-2d · M3 · ISO tables 1: catalogue copy, systems, checklist, documents, certification, files
- **Thread title:** "ISO-2d: ISO tables, part 1". **Needs:** ISO-2c. **Status:** merged (#276).
- **Read:** model §1, §2, §3.1-3.4, §3.8-3.9 (audit_finding is created in ISO-2e), §6; `packages/db/CLAUDE.md`.
- **Paths:** `packages/db/` (new `src/schema/iso.ts`, migrations, repositories, tests; `packages/db/CLAUDE.md` table
  list).
- **Delivers:** tables `iso_standard`, `iso_clause`, `iso_review_input_def`, `iso_review_output_def` (firm-wide,
  writes only under `app_system_job()`), `management_system`, `management_system_unit`, `context_item`,
  `clause_assessment`, `controlled_document`, `document_revision`, `certification`, `certification_unit`,
  `external_audit`, and `iso_file` (one nullable FK column per subject in model §6; the columns for subjects created
  in ISO-2e are added there). Every rule of model §1: client policies, composite FKs, `num_nonnulls` checks, archived
  join rows, purge list. Repositories: catalogue reads and system-context writes; CRUD and list (with unit-scope
  list filters per plan §3.3, joining the management system's units for records without their own) per record;
  `clauseAssessments.addForStandards` (the checklist rows of a new system and of a standard added to one;
  `managementSystems.create` adds none);
  `isoFiles.create/get/forSubject/pendingScan(tx, limit)/setScanStatus/archive(tx, id, reason)/cleanForClient`, where
  `pendingScan` does not join instances.
- **Tests:** isolation test per table; schema-rules and purge-list tests; FK tests (a client-A record cannot point at
  a client-B unit or ISO record); catalogue writes refused outside the system context; `num_nonnulls` refusals.

## ISO-4b · M5 · ISO policy rows, `hasFeature`, readiness and multi-unit scope
- **Thread title:** "ISO-4b: ISO permissions". **Needs:** ISO-1a, ISO-2c, ISO-4c.
- **Read:** plan §3, §4.2-4.3; `apps/api/CLAUDE.md` roles.
- **Paths:** `apps/api/src/auth/`.
- **Delivers:** one `POLICY` row per ISO action ISO-1 and ISO-1a list (plan §3.2, `isoNc.reassign` included; each
  route has one action, so each row is that route's grant), no wildcard; `inScope` requires an overlap
  with the membership's `unitIds` when `resource.unitIds` is present; `hasFeature(ctx, flag)` (no throw, for lists that
  leave ISO rows out); `requireFeature(ctx, 'isoManagement')` also answers 409 `FEATURE_NOT_READY` while the copy
  is not recorded: a new `AuthStore.isoCatalogueCopied(firmId)` in `db-store.ts` reads `account.isoCatalogueCopiedAt(tx)`
  (ISO-2c) in a lookup transaction on every gated request, as `accountFeatures` reads `account.features(tx)`;
  the test store in `apps/api/src/auth/testing.ts` gets the same method.
- **Tests:** policy table per role × action, own and not own; unit overlap; readiness before and after the marker.

## ISO-10a · M9 · Copy the ISO catalogue when the add-on comes on
- **Thread title:** "ISO-10a: copy the ISO catalogue on switch-on". **Needs:** ISO-1, ISO-2c. **Status:** merged
  (#277).
- **Read:** plan §4.3; `docs/adr/M9-0002-account-jobs.md`.
- **Paths:** `apps/api/src/jobs/` (`ports.ts`, a new `iso-catalogue.ts` consumer and sweep, `consumers.ts`
  (`CONSUMERS`), `postgres-store.ts` (`FirmTx`), `testing/memory-store.ts`, `runner.ts` `JOBS`, `start.ts` options,
  tests).
- **Delivers:** `IsoCatalogueCopier` port beside `LibraryCopier`, passed through `startJobsFromEnv` like
  `copyLibrary`; a consumer of `account.features_changed` that calls it when `added` has `isoManagement`; a sweep job
  every 10 minutes over TRIAL and ACTIVE accounts whose features include `isoManagement` and whose copy is not
  recorded; `FirmTx.accountFeatures()` beside `accountStatus()`, returning `{ features, isoCatalogueCopiedAt }`
  from M3's `account.features(tx)` (ISO-2a, merged) and `account.isoCatalogueCopiedAt(tx)` (ISO-2c), in `postgres-store.ts` and
  `testing/memory-store.ts`, read once per firm per run. The sweep calls the copier only where
  `isoCatalogueCopiedAt` is null, and ISO-10b and ISO-10c use the same read to skip accounts not yet copied.
  `account.isoCatalogueCopiedAt(tx)` and `accountJobs.markIsoCatalogueCopied(tx)` come with ISO-2c (#273); the
  copier (ISO-9) calls the latter. The marker sets nothing and returns false outside TRIAL and ACTIVE (PROVISIONING
  included), so such a copy copies nothing; the consumer treats that as done, not as a failure, and the sweep copies
  once the account is in TRIAL or ACTIVE.
- **Tests:** the event twice and the sweep at once copy once (with a fake copier that records calls); no call without
  the feature; a missing copier makes the consumer fail loudly, as the `account.created` consumer does; a copier
  answering `copied: false` (account not TRIAL or ACTIVE) acknowledges the event, and a later sweep with the account
  ACTIVE copies.

## ISO-6b · M17 · ISO screens 2: risks, objectives, actions
- **Thread title:** "ISO-6b: ISO screens, part 2". **Needs:** ISO-6a, ISO-1b (the mock accepts the ISO export kinds
  only once they join `ExportKind`).
- **Read:** model §3.5, §3.6, §3.12, §4.7, §5.1, §10; `docs/contracts/iso-mock.md` ("Risks and objectives", and the last
  two sentences of "Nonconformities", on actions).
- **Paths:** `apps/web/app/(shell)/c/[clientId]/iso/{risks,objectives,actions}/`, `e2e/tests/iso/`.
- **Delivers:** risk register with tabs per kind, the kind-specific fields, existing controls with hierarchy, treatment
  actions, inherent and residual rating and significance (from the API), override with reason, review; objectives
  with standards, linked risks, readings, progress and action plans; the actions list (filter by subject, owner,
  state) and an Actions panel on every subject page; "Download risk register (Excel)" through
  `POST /clients/{clientId}/exports` with `ISO_RISK_REGISTER_XLSX`. Every step button comes from the view's
  `allowedActions` (model §10), as in ISO-6a; an owner or approver change and a moved date ask for a reason
  (model §1.9); states and codes in model §4.7's words, as in ISO-6a.
- **Tests:** e2e against the mock: add a hazard with controls and a treatment action, complete it, see the control; an
  objective reading; the actions list as an owner; the risk register download; M11's shell ISO test stays green for
  the pages this package adds; a11y and layout checks as in ISO-6a.

## ISO-12c · M13 · Statutory numbers link to Law only
- **Thread title:** "ISO-12c: overview and portfolio links say Law". **Needs:** ISO-1, ISO-11c, ISO-12a.
- **Read:** plan §4.6; `docs/adr/M12-0001-register-url-state-and-saved-views.md` (the register's URL state);
  `apps/web/CLAUDE.md`.
- **Paths:** `apps/web/app/(shell)/c/[clientId]/overview/`, `apps/web/app/(shell)/portfolio/`, `e2e/tests/overview/`.
- **Delivers:** when the shell model has `isoManagement`, every register or calendar link built from a statutory
  number (`registerHref` in `overview-model.ts` and in `portfolio-model.ts`, the calendar link and the
  `dueThisWeekFilter` link included) adds `source=LAW`, keeping a `source` the API already puts on
  `PortfolioRow.dueThisWeekFilter` (ISO-11b); without the add-on the links are unchanged. The links are built in the
  web, so M10 cannot do this.
- **Tests:** unit tests for both hrefs on and off; e2e against the mock checking that a KPI count equals the rows of
  the register it opens, for a user with the add-on; light mode at 1280 and 375, keyboard-only, axe.

## ISO-9 · M6 · ISO catalogue as code and `copyIsoCatalogue`
- **Thread title:** "ISO-9: the ISO catalogue and its copy". **Needs:** ISO-2d. **Status:** merged (#279), with the
  400 refusals of ISO-9b for STANDARD act edits and merges and for moves across kinds; it seeded the v1 editions only
  (ADR M6-0003 decision 8, catalogue §6).
- **Read:** catalogue.md (all); plan §4.3; `docs/adr/M6-0001-master-library-copy.md`.
- **Paths:** `apps/api/src/modules/library/` (`iso-catalogue.ts`, `db-iso-catalogue-copy.ts`, tests),
  `docs/adr/M6-NNNN-iso-catalogue.md`.
- **Delivers:** the catalogue bundle (editions, clauses with titles and our summaries, `assessable`,
  `exclusionAllowed`, review input and output definitions, the four STANDARD acts with the fixed values and at least
  the activity catalogue, each activity once), checked before any copy; `copyIsoCatalogue(db, accountId, requestId)`
  in the account's system context: returns `copied: false` without the feature, when already copied, or when the
  account is not TRIAL or ACTIVE (`accountJobs.markIsoCatalogueCopied(tx)` returns false then, ISO-2c, #273); marks
  first, then copies, reusing same-name STANDARD acts and categories, with a CREATE `AuditEvent` (actor SYSTEM) per act,
  category and obligation. The ADR records the confirmed `exclusionAllowed` list and the editions seeded. Writes go
  through M3's `isoCatalogue.createStandard`, `createClauses`, `createReviewInputDefs` and `createReviewOutputDefs`
  (ISO-2d, #276), which work only in a system-job context; rows may carry their own ids, so a clause tree goes in one
  statement. The database refuses `exclusionAllowed` on a clause that is not assessable, and a second definition of a
  review key for one standard or an item of more than one letter and a digit (catalogue §4, §5).
- **Tests:** copy into an account that already holds the master library and a same-name statutory Act; copy twice
  (second copies nothing); no STANDARD rows in `copyMasterLibrary`; every catalogue §3 activity once; no clause summary
  matches standard text (review in the PR).

## ISO-2e · M3 · ISO tables 2: risks, objectives, actions, audits, NCs, reviews
- **Thread title:** "ISO-2e: ISO tables, part 2". **Needs:** ISO-2d. **Status:** merged (#280).
- **Read:** model §1, §3.5-3.7, §3.9-3.13, §6.
- **Paths:** `packages/db/`.
- **Delivers:** tables `risk_item`, `risk_control`, `objective`, `objective_reading`, `objective_risk_item`,
  `audit_programme`, `internal_audit`, `internal_audit_unit`, `internal_audit_person`, `audit_checklist_item`,
  `audit_finding`, `nonconformity` (per-client number sequence, incident columns, FK to `compliance_instance` for
  `sourceInstanceId` and `statutoryInstanceId`), `nonconformity_person`, `nonconformity_risk_item`,
  `nonconformity_document`, `iso_action`, `management_review`, `management_review_person`, `review_input`,
  `review_output`; the remaining `iso_file` subject columns, with `iso_file_subject_check` widened to them and
  `FILE_SUBJECTS` extended (both from ISO-2d, #276); repositories with unit-scope list filters per plan §3.3, joining
  the management system's units for records without their own; the purge list extended to every new table.
- **Tests:** as ISO-2d, plus the `num_nonnulls` checks of `audit_finding` and `iso_action`, the NC number sequence
  per client, and an `iso_file` row on each new subject (and none on two subjects at once).

## ISO-15 · M7 · ISO file service (`IsoFiles`)
- **Thread title:** "ISO-15: files for ISO records". **Needs:** ISO-1b, ISO-2d.
- **Read:** model §6; `docs/adr/0004-m7-instance-workflow.md`; `apps/api/CLAUDE.md`.
- **Paths:** `apps/api/src/modules/evidence/` (new `index.ts` public index, `db-iso-files.ts`,
  `db-iso-files.db.test.ts`). The `db-` prefix keeps it out of the unit coverage run and holds it to the floor file by
  file in `vitest.db.config.mjs`, as for `service.ts`.
- **Delivers:** `createIsoFiles({ storage })` in `modules/evidence/db-iso-files.ts`, re-exported from
  `modules/evidence/index.ts`, matching the `IsoFiles` port in model §6, which ISO-8a declares in M16 (upload
  ticket, confirm → PENDING, list by subject, CLEAN-only 5-minute download URL, remove with reason → archived
  through M3's `isoFiles.archive(tx, id, reason)`), with the evidence file-type, size and name rules, ISO keys under
  `evidence/<firmId>/<clientId>/iso/...`, and the `AuditEvent` on the ISO subject (`EVIDENCE_ADD`,
  `EVIDENCE_DOWNLOAD`, `EVIDENCE_REMOVE`, model §6), all in the caller's tenant transaction. No route: M16 serves the
  routes and decides who may call each one (unit scope, locks, the incident-file rule). Until ISO-2e merges, M3
  stores files only on clause assessments, document revisions, external audits and certifications (another subject
  answers DbError `VALIDATION`), so the tests use those four; `isoFiles.archive` answers `NOT_FOUND` for a file
  already removed.
- **Tests:** db tests for each call, the key shape, CLEAN-only download, archive not delete, no signed URL or file
  content logged; `confirm`, `downloadUrl` and `remove` each write exactly one `AuditEvent` of that action on the ISO
  subject (entity type, id, `after` naming the file id and never the file name or a URL) in the caller's
  transaction; `uploadUrl` and `list` write none; a refused call (file not CLEAN) writes none; a rolled-back caller
  transaction leaves neither the `iso_file` row nor its event.

## ISO-8a · M16 · ISO API 1: gate, audit gate test, systems, checklist, documents, certification, files
- **Thread title:** "ISO-8a: ISO API, part 1". **Needs:** ISO-1b, ISO-2d, ISO-3, ISO-4b.
- **Read:** plan §3-4; model §1, §3.1-3.4, §3.8, §4 preamble, §4.2, §4.4 (RECORD_HELD and CANCEL), §4.6, §5.1
  (`clauseReadiness`, `climateDeterminationGaps`), §6, §10; `apps/api/CLAUDE.md`; `docs/contracts/README.md`
  decisions 42-51 and `docs/contracts/iso-mock.md` ("Shared rules", including file scans; "Systems and checklist";
  "Documents"; "Certifications"; the file rules in "Management reviews and files"; "Core routes with the switch off").
- **Paths:** `apps/api/src/modules/iso/` (routes, services, `ports.ts` with `IsoFiles`, `testing/`,
  `audit-gate.db.test.ts`), `apps/api/src/server.ts` (shared: M16's routes mounted inside the existing
  `options.database` block, as the instance routes are; the file routes only when an `IsoFiles` is given),
  `docs/adr/M16-NNNN-...` if a decision needs one.
- **Delivers:**
  - `requireFeature` on every route (403 off, 409 not ready).
  - Systems, context, climate decision (once decided, never back to null), catalogue reads, checklist with the N/A
    machine (`statusBeforeNa`, WITHDRAW_NA) and the climate rule, documents and revisions (model §4.2, EXTERNAL
    editions through RECORD_EDITION), certifications and external audit visits (§4.4 RECORD_HELD and CANCEL; no
    findings, which ISO-8c adds).
  - What ISO-2d (#276) leaves to M16. A new system, and a standard added to one, get their checklist rows through
    `clauseAssessments.addForStandards(tx, system, standardIds)` in the same transaction (`managementSystems.create`
    adds none). On APPROVE and RECORD_EDITION, in one transaction and in this order: the previous APPROVED revision
    goes to SUPERSEDED (a unique index allows one APPROVED revision per document), this revision goes to APPROVED,
    then the document's `currentRevisionId` moves to it. A trigger on the document, not a foreign key, checks that
    `currentRevisionId` names an APPROVED revision of that document, and it fires only when the document is written,
    never when a revision changes: test that a document never points at a SUPERSEDED revision. One trigger
    (`management_system_guard`) keeps `standardIds` growing only and the climate decision from going back to null,
    raising `check_violation` (DbError `VALIDATION`); M16 checks both first and answers `400 VALIDATION`, so a
    trigger error never reaches a caller.
  - The id checks the database leaves to M16, on every write, each `400 VALIDATION`: every id in a `standardIds` or
    `clauseIds` list is in the account's catalogue copy (model §1.4), and a certificate's `standardId` and an
    external audit's `standardIds` are among its system's `standardIds` (model §3.8), as the mock's
    `checkStandards` does (`packages/contracts/src/mock/handlers/iso/certifications.ts`). ISO-8b and ISO-8c apply
    the same rule to their own lists (`obligationIds` on a risk item, `clauseIds` on audits, findings and NCs).
  - File routes through the `IsoFiles` port for the ISO-2d subjects, with unit scope, the lock rule (an IN_REVIEW
    revision's file included) and a hook for per-subject download rules (ISO-8c uses it for incident NCs).
  - One `Resource` builder implementing plan §3.2's "own" rules, and the maker-checker rule of model §4's preamble;
    it sets `Resource.unitIds` from the record's units (plan §3.3) and leaves it out when that list is empty, which
    means every unit.
  - A reason on every field edit audited as `REASSIGN` or `DUE_DATE_CHANGE`, none on a date a step sets (model §1.9).
  - Transitions through ISO-3's `isoTransition`, which reads named facts: contract field names, `asOf` and counts
    such as `openActionCount`, listed on `ISO_TRANSITIONS` in `packages/engine/src/iso-status.ts`. A missing fact
    fails its guard; lock guards return `409 INVALID_TRANSITION`; maker-checker is the separate `isoMayCheck`, which
    answers `403 FORBIDDEN`. ADR M4-0001 records that the engine keeps every mock stand-in.
  - `allowedActions` on every view of a record with a machine, from the same rules the routes enforce (model §10);
    the catalogue reads under `isoSystem.read`; `standardIds` only grows (model §3.1); a certificate's number, issue
    and expiry dates set together (§3.8); a recorded external edition with no `approvedById` (§3.4).
  - The mock's picks for these areas (`docs/contracts/iso-mock.md`) kept, or replaced in an M16 ADR and sent to the
    coordinator for the matching mock change.
  - Closed records read-only (model §1.8); unit scope in every list, read and count per plan §3.3; person checks.
  - The audit gate test of plan §7 item 2.
- **Tests:** per route and role (allowed and one refused), off and not-ready answers, every arrow and refused arrow,
  unit scope, people, locks and field edits refused on each locked subject, with a fake `IsoFiles`; the `Resource`
  builder for a non-lead auditor and a chair in each role; for each record kind, a unit-limited reader is allowed by
  `can()` exactly the records the list SQL returns to them (#281 audit Info: the M5 unit rule holds only if
  `Resource.unitIds` follows plan §3.3 as the lists, overview counts and exports do). ISO-8b and ISO-8c add the same
  test for their kinds.

## ISO-2f · M3 · Act-kind and feature-aware reads, accounts by feature
- **Thread title:** "ISO-2f: reads that tell laws from ISO activities". **Needs:** ISO-2e.
- **Read:** plan §4.3-4.6; `docs/adr/0003-m3-tenant-isolation-in-postgres.md` (ids-only system reads);
  `packages/db/migrations/0007_list_firm_ids.sql`.
- **Paths:** `packages/db/` (repositories, `src/database.ts`, one migration that adds a function and changes no
  table, tests).
- **Delivers:** an `actKinds` filter on `instances.register`, the reads behind `/me/approvals` and `/me/tasks`, the
  vault, the calendar, the overview and breakdown reads, the report reads, and `jobs.listScoreItems` (which feeds the
  digest); library and assignment list reads take the same filter; a by-id lookup of an instance's, obligation's or
  assignment's act kind for the off-switch checks. `Database.listFirmIdsWithFeature(flag)` beside `listFirmIds()`: the
  ids, and nothing else, of the TRIAL and ACTIVE accounts whose effective features include `flag` (through
  `canopy_effective_features`, 0039), from a SECURITY DEFINER function with the same callers as
  `canopy_list_firm_ids()`, so the jobs read every account only when they must (#277 audit Info 2). The function is
  owned by `canopy_lookup`, the one owner whose policy (`lookup_read`, 0008) sees every firm. It already reads `firm.id`
  and `firm.status` (0007, 0020) and gets column grants only for what the function joins on or reads (`firm.plan_code`,
  USAGE on schema `platform`, `platform.plan (code, features)` and `platform.account_override (account_id, features,
  removed_features)`), never a whole row. It returns ids only (#278 audit Info; #282).
- **Tests:** each read with STATUTE only, STANDARD only and both; `listScoreItems` leaves a STANDARD instance in range
  out when asked; `listFirmIdsWithFeature` with the flag from the plan, from an override, removed by an override, and
  on a SUSPENDED, PENDING_DELETION and PROVISIONING account (none listed); the app role can call it and nothing else
  can.

## ISO-2g · M3 · Stored review figure columns and live-only review-row keys
- **Thread title:** the M3 ISO thread continues, after ISO-2f. **Needs:** ISO-2e, ISO-1a2.
- **Read:** model §1.7, §3.13; ADR M16-0003; `packages/db/CLAUDE.md`.
- **Paths:** `packages/db/` (one migration, in its own PR since it changes existing tables, with the repository lines it
  forces; tests; `packages/db/CLAUDE.md`).
- **Delivers:**
  - `review_input.source_figures jsonb`, `figures_stored_at timestamptz` and `figures_engine_version text`: all null or
    all set (a check), `source_figures` a JSON object (a check). A trigger (BEFORE UPDATE on `review_input`) allows one
    update that sets the three from all null to all set; once `figures_stored_at` is set, it refuses any change to them,
    to `input_def_id`, to `management_review_id` and to `archived_at` (`check_violation`, DbError `VALIDATION`). `notes`
    stays free, and the account purge only deletes.
  - `review_input_def_key` and `review_output_def_key` become unique among live rows (`archived_at IS NULL`), and
    `addReviewRows`' `ON CONFLICT` arbiter takes the same `WHERE archived_at IS NULL` in the same PR, since the old
    target no longer matches a constraint (#280 audit Info 1).
  - M3's review-input reads return the three columns, parsed by 1.8.2's `ReviewInput`.
  - `packages/db/CLAUDE.md` rule 7 (derived status is not stored) gains its exception: a held review's figures are a
    record (model §1.7).
- **Tests:** both checks; the trigger's allowed first write and each refused change after it (the three columns, the
  definition, the review, the archive), with `notes` still editable; `addReviewRows` run twice adds nothing; a live and
  an archived row for the same key; the migration test.

## ISO-2h · M3 · Review figure reads: gather, store, visible ids, rows that follow a replan
- **Thread title:** the M3 ISO thread continues. **Needs:** ISO-2g, ISO-1a3.
- **Read:** model §3.5, §3.13, §5.4, §8; plan §3.3; ADR M16-0003; `packages/db/CLAUDE.md`.
- **Paths:** `packages/db/` (repositories and tests; no migration).
- **Delivers:**
  - `reviewFigures.gather(tx, review, inputDef, asOf, localDay)`: `{ since, data }` for one input row, as model §5.4
    sets them. `localDay` turns an instant into a client-local day: the caller passes the engine's `localDateIn` with
    the client's time zone, since `packages/db` does not import the engine (root rule 4, `packages/db/CLAUDE.md`).
    `since` comes from the system's `createdAt` through `localDay` and the other HELD or CLOSED reviews of the input's
    standards held on or before `asOf`. `data` is the contract's `ReviewFigureData[source]`, from the system's records
    with no unit scope, archived ones included, filtered by each source's rule (risk kinds by input key, findings by
    their clauses' standards), every timestamp a day through `localDay`, and the event and step days read from
    `audit_event` (the latest step where there are several; the residual clear that carries `sourceActionId` left out).
    M16 (ISO-8c) and M10 (ISO-11d) both call it.
  - `reviewInputs.storeFigures(tx, id, figures, engineVersion)`: checks `figures` against `ReviewInputFigures`, sets
    `figures_stored_at` to `now()`, and refuses a row that already has figures.
  - `isoVisibleIds(tx, clientId, refs, scope?)`: `refs` is a list of `{ table, ids }`, the table taken from the
    contract's `REVIEW_FIGURE_KEYS`. It returns the ids that are rows of the client in that table, archived ones
    included, and, given a `UnitScope`, only those the scope may read: plan §3.3 for the ISO tables, and the register's
    unit-only rule for `compliance_instance` (no named-person exception, as the instance routes). With no scope (a
    reader who sees the whole client) it still drops ids that are not the client's.
  - `reviewInputs.syncForReview` and `reviewOutputs.syncForReview(tx, review, standardIds)`: bring a PLANNED review's
    rows in line with its standards as the mock's `syncRows` does (model §3.13), and return the keys added and removed
    for M16's event on the review; a review in any other state is refused.
- **Tests:** `gather` per source with records of other units, archived records, a record created after `asOf`, a
  backdated audit step, a residual clear left out of `ratingChanges`, risk kinds per input key (a 14001 review's
  `SIGNIFICANT_ASPECTS` gets ASPECT items only and its `RISKS_AND_OPPORTUNITIES` none), instants either side of local
  midnight placed by the `localDay` given, and a first review (`since` is the system's creation day); `storeFigures`
  twice refused; `isoVisibleIds` for a unit-limited scope, a named person, no scope, an instance on another unit and an
  id from another client; `syncForReview` with a standard dropped and added back (a new live row, the archived one kept
  with its notes), with a key shared by two standards when one is dropped (one row, repointed to the other's
  definition), and on a HELD review (refused).

## ISO-6c · M17 · ISO screens 3: audits, nonconformities, management reviews
- **Thread title:** "ISO-6c: ISO screens, part 3". **Needs:** ISO-6b, ISO-1a3 (the mock's stored figures,
  `REVIEW_FIGURE_KEYS` and `figuresWithheld`).
- **Read:** model §1.9, §3.7, §3.9-3.11, §3.13, §4.1, §4.3, §4.5, §4.7, §9 (the review pack), §10; catalogue §5;
  `docs/contracts/iso-mock.md`
  ("Internal audits", "Nonconformities", "Management reviews and files").
- **Paths:** `apps/web/app/(shell)/c/[clientId]/iso/{audits,nonconformities,management-reviews}/`, `e2e/tests/iso/`.
- **Delivers:** programme with coverage, internal audits with checklist, independence note, findings (an NC finding
  raises its NC), report and close; the NC log and NC page with every action of model §4.1, each offered only when the
  view's `allowedActions` lists it (model §10), incident fields with the personal-data notice, the reportable notice and
  the statutory-instance link (an instance picker, as for `sourceInstanceId`), raising from a finding, a risk item, or
  with an instance picker (`sourceInstanceId`), and a link to the source; a raise by hand offers every source but the
  two audit sources (model §4.1); a Reassign form on the NC's reassign route for account admins, consultants and client
  admins (`isoNc.reassign`, plan §3.2): owner, approver, dates and, while OPEN or ROOT_CAUSE_FOUND on an NC raised by
  hand, severity and incident outcome, always with a reason (model §3.10); the owner editing every other field through
  the NC's PATCH; a finding's type changes only as model §3.9 allows; management reviews with their standards, date and
  chair changed on the replan route while PLANNED (client admins and above; a new date or chair with a reason), inputs
  shown with their `sourceFigures` (headed "Recorded <figuresStoredAt>, for <since> to <heldOn>" when stored, "No
  figures: held before the system was set up in the app" for a HELD or CLOSED row without them, "Live, to today" when
  PLANNED, "Not held" when CANCELLED; each figure worded from `REVIEW_FIGURE_KEYS`, with a test that every listed key
  has words; "N (M you can open)" when a figure whose value is the number of its ids (`REVIEW_FIGURE_KEYS`) has fewer
  ids than its value, and otherwise its value with "M records you can open"; "Figures withheld: they include incidents
  at units outside your access" when `figuresWithheld`, with the row's notes), a note on the RECORD_HELD form, when
  `heldOn` is before today, that the stored figures will count records up to `heldOn` but read their state (cancelled,
  severity, significance, outcome, finding type, instance workflow) as it is today, so they can differ from the live
  figures shown, and another when a review of the same standards is already recorded with a later `heldOn`, whose
  figures stay as they are; outputs, actions and the pack download; "NC log (Excel)" and "Audit report (PDF)" downloads
  beside the review pack, through `POST /clients/{clientId}/exports`. States and codes read in model §4.7's words, as in
  ISO-6a (a finding's type "Major nonconformity", a review's input rows by their definition's title).
- **Tests:** e2e against the mock: plan and report an audit with an NC finding; take an NC from OPEN to CLOSED and back
  through VERIFY_NOT_EFFECTIVE; hold and close a review, and see its figures unchanged after closing an NC it counted;
  an owner limited to one of the system's units, not on the review, sees the INCIDENTS row withheld; the three
  downloads; M11's shell ISO test stays green for the pages this package adds; a11y and layout checks as in ISO-6a.

## ISO-8b · M16 · ISO API 2: risks, objectives, actions
- **Thread title:** "ISO-8b: ISO API, part 2". **Needs:** ISO-8a, ISO-2e.
- **Read:** model §1.9, §3.5, §3.6, §3.12, §5.1, §8, §10; `docs/contracts/iso-mock.md` ("Shared rules"; "Risks and
  objectives"; the last two sentences of "Nonconformities", on actions on a closed subject and controls from a reopened
  treatment action; "Stand-ins for M4 formulas", which M16 calls the engine for).
- **Paths:** `apps/api/src/modules/iso/`.
- **Delivers:** risk items with kind rules, rating and significance from the engine at write, override, controls, review
  (owner, or FA, CO or CA), the re-rating rule when a treatment action completes, its clear of the residual rating
  written as one UPDATE on `risk_item` whose `after` carries the action's `sourceActionId` (model §8; a re-rating
  through the PATCH never carries it, and the review figures tell the two apart by it); objectives and readings;
  `IsoAction` for every subject with COMPLETE, CANCEL, REOPEN (subject open as model §3.12 defines) and the risk-control
  rule, refusing actions on MAJOR_NC and MINOR_NC findings; the cross-row rules ISO-2e (#280) leaves to M16, each
  `400 VALIDATION`: a control's source action belongs to its risk item, and an objective's standards are among its
  system's; file routes for risk items, objective readings and actions through the `IsoFiles` port, with unit scope and
  the lock on DONE or CANCELLED actions; rows in the audit gate test for each new route; `allowedActions` on actions;
  the mock's picks kept or replaced by ADR, as ISO-8a.
- **Tests:** as ISO-8a, including field edits refused on each locked subject; completing the last OPEN treatment action
  writes that UPDATE with `sourceActionId`, and a PATCH that re-rates writes one without it.

## ISO-8c · M16 · ISO API 3: internal audits, external-audit findings, nonconformities, management reviews, overview
- **Thread title:** "ISO-8c: ISO API, part 3". **Needs:** ISO-8b, ISO-2h, ISO-3b.
- **Read:** model §1.7, §1.9, §3.7-3.11, §3.13, §4 preamble, §4.1, §4.3, §4.4, §4.5, §5.1-5.2, §5.4, §6, §8, §9 (unit
  scope only), §10; plan §3.3 (the review figures' exception); ADR M16-0003; `docs/contracts/iso-mock.md` ("Shared
  rules"; "Internal audits"; "Nonconformities"; "Certifications"; "Management reviews and files"; the "Overview", "NC
  status" and "Management review figures" stand-ins, where M16 passes `since` to `reviewInputFigures`).
- **Paths:** `apps/api/src/modules/iso/`.
- **Delivers:**
  - Programmes, internal audits with checklist, independence rule, findings creating NCs in the same transaction.
  - External-audit findings (creating NCs), RECORD_RESPONSE and CLOSE (model §4.4).
  - Nonconformities with every arrow and guard of model §4.1, the disposition rule, incident rules (type and source,
    lost days, the statutory-instance link checked for unit and act kind) and the personal-data rule; a raise by hand
    refused for the two audit sources; the NC's reassign route (`isoNc.reassign`; FA, CO, CA: owner, approver, dates,
    severity and incident outcome, with a reason; severity and outcome only while OPEN or ROOT_CAUSE_FOUND and never on
    a finding's NC) and its PATCH (`isoNc.work`; CA, OW own: every other field), model §3.10, §3.11 and §4.1;
    `rootCauseMethod` at ADD_ROOT_CAUSE, `dueOn` not before `reportedOn`, the lead not also an auditor; a finding's type
    moves as model §3.9 allows, the NC's severity following, only while the NC is OPEN or ROOT_CAUSE_FOUND and never by
    the NC's own owner.
  - Management reviews with input and output rows from the account's definitions; the review's PATCH
    (`isoReview.write`, its chair included) and the replan route for standards, date and chair while PLANNED
    (`isoReview.plan`; a new date or chair with a reason), which changes the rows through ISO-2h's `syncForReview`
    and names the keys added and removed in its event, model §1.9, §3.13 and §4.5.
  - Review figures (model §3.13, §5.4): `since` and `data` from ISO-2h's `reviewFigures.gather` (given the engine's
    `localDateIn` with the client's time zone), with `asOf` as model §5.4 sets it; computed live for a PLANNED review;
    computed once inside the RECORD_HELD transaction with `asOf = heldOn` and stored through `reviewInputs.storeFigures`
    with `ENGINE_VERSION`, the values and the engine version also in the TRANSITION event's `after` (model §8); none
    stored for a review held before its system's `createdOn`; RECORD_HELD refuses a `heldOn` after the client-local
    today; a HELD or CLOSED review returns the stored copy and never computes; null for CANCELLED, `MANUAL` and unstored
    rows; each figure's ids cut through `isoVisibleIds`, with the tables `REVIEW_FIGURE_KEYS` names, for every reader;
    the INCIDENTS row withheld (`figuresWithheld`) from an approver or owner whose units do not cover every unit of the
    system (a system with no units covers every unit of the client) and who is neither the review's chair nor an
    attendee (model §3.13 item 4).
  - The cross-row rules ISO-2e (#280) leaves to M16, each `400 VALIDATION`: a checklist row's finding belongs to the
    same audit, and the standards of an NC and of a review are among its system's. NC raises run at the default READ
    COMMITTED isolation: the NC number trigger takes `max + 1` after its lock (#280 audit Info 2).
  - The ISO overview (model §5.1-5.2 engine results with the ids behind each number), under `isoSystem.read`.
  - File routes for internal audits, findings, nonconformities and management reviews with the model §6 lock rules,
    and the incident-file download rule (model §6).
  - Rows in the audit gate test for each new route; `allowedActions` on audits, NCs and reviews; the mock's picks
    kept or replaced by ADR, as ISO-8a.
- **Tests:** as ISO-8a, plus plan §7 items 6, 8 and 9; an NC owner with the OWNER role is refused on the reassign route
  (owner, approver, dates, severity, outcome), FA and CO are refused on the NC's PATCH, severity and outcome are refused
  after ROOT_CAUSE_FOUND and on a finding's NC, and a finding's MAJOR_NC/MINOR_NC move is refused once its NC has left
  ROOT_CAUSE_FOUND and for the NC's owner; a chair is refused on the replan route; a held review's figures are the same
  after an NC it counted is closed, a risk is re-rated and a record is archived, and RECORD_HELD stores them once (a
  backdated and a same-day `heldOn`; none for a review held before its system's `createdOn`); a unit-limited reader and
  a chair outside the system's units get the system's values with ids cut, and the INCIDENTS row is withheld from that
  reader but not from the chair or an attendee; a replan that drops and re-adds a standard; the RECORD_HELD row in the
  audit gate test asserts `figures` and `engineVersion`; a locked subject refuses add and remove for every role, and
  field edits; a viewer and an owner of the unit who is not named on an incident NC cannot download its files; a plant-A
  owner sees none of a plant-B-only system's objectives, reviews or unit-less NCs.

## ISO-9b · M6 · Hide and refuse STANDARD library rows when off; no cross-kind changes
- **Thread title:** "ISO-9b: the library respects the ISO switch". **Needs:** ISO-9, ISO-2f, ISO-4b.
- **Read:** plan §4.4-4.5; catalogue §2.
- **Paths:** `apps/api/src/modules/{library,assignments}/`.
- **Delivers:**
  - With the feature off, library act and obligation lists leave out STANDARD rows and by-id, push and merge answer
    403 for them; assignment lists leave out, and create, bulk and by-id refuse, assignments on STANDARD obligations.
  - Whatever the feature, a merge of acts of different kinds and an obligation create or update that would cross
    kinds answer 400 `VALIDATION`. ISO-9 (#279) already does this and the next point; ISO-9b keeps them and tests
    them with the feature on and off.
  - A STANDARD act is never edited or merged by staff: its values are fixed (catalogue §2), and the copy finds it by
    name. The update and merge routes answer 400 `VALIDATION` for it (after the off switch's 403); there is no
    act-archive route, and the merge route, which archives its source acts, refuses a STANDARD source. The database
    still lets staff do it (ISO-2c audit on #273), so this is the only guard.
  - `clauseRefs`: nothing to build. The obligation create and update bodies are strict and have no such field (contracts
    `entities.ts`), so a body that names it answers 400 `VALIDATION` on and off, under either kind of act (plan §4.4).
    The database takes it on any obligation in any account (ISO-2c audit on #273), and only the catalogue copy writes
    it. The PR amends ADR M6-0003's Consequences to match: the obligation bodies never carry `clauseRefs` in v1 (plan
    §4.4), so the only refusal is the contract's 400.
- **Tests:** route tests per role, on and off; cross-kind refusals; a STANDARD act's update and merge refused for every
  staff role, as the merge target and as a source; an obligation create and an update that name `clauseRefs` answer 400,
  on and off, under a STATUTE and a STANDARD act, and the stored references do not change.

## ISO-11a · M7 · Source filter and the off switch on instances and evidence
- **Thread title:** "ISO-11a: instances and evidence respect the ISO switch". **Needs:** ISO-15, ISO-2f, ISO-4b.
- **Read:** plan §4.4-4.6.
- **Paths:** `apps/api/src/modules/{instances,evidence,approvals,audit}/`.
- **Delivers:** `source` on the instance list, `/me/approvals`, `/me/tasks` and the vault when the feature is on; with
  it off those leave STANDARD instances out, and instance get, patch and transitions, bulk approve (per item),
  comments, evidence upload, list, download and remove, and instance audit answer 403 `FEATURE_NOT_ENABLED` for a
  STANDARD instance. The client audit trail is not gated.
- **Tests:** per route, on and off, per role; M7's audit gate test rows for any new refusal path.

## ISO-10b · M9 · Off switch in the existing jobs, STATUTE-only digest, ISO file scan
- **Thread title:** "ISO-10b: jobs respect the ISO switch". **Needs:** ISO-10a, ISO-1b, ISO-2d, ISO-2f.
- **Read:** plan §4.2, §4.4, §4.6; model §6.
- **Paths:** `apps/api/src/jobs/`.
- **Delivers:** generate-instances skips assignments on STANDARD obligations of an account without the feature or not
  yet copied; reminders, escalations and the workflow-emails consumer skip STANDARD instances when off (the consumer
  re-reads features when it handles a queued event); the consultant digest's score and counts read STATUTE-act
  instances only, on or off; the scan job also scans PENDING `iso_file` rows (`isoFiles.pendingScan`), with the
  add-on on or off (plan §4.5), and writes the `AuditEvent` on the ISO subject (`isoFileSubject(file)`), with no
  `evidence.scanned` event. `pendingScan(tx, limit)` takes 1 to 200, so the batch never asks for more; `setScanStatus`
  checks no state, so the job re-reads the file with `isoFiles.get` and skips one no longer PENDING or archived, as
  `recordScan` does for evidence. ISO-10a's sweep moves onto `listFirmIdsWithFeature('isoManagement')` (ISO-2f).
- **Tests:** one due STANDARD instance leaves the digest's score, overdue, due-soon and awaiting-approval figures
  unchanged; no reminder or email for a STANDARD instance when off; an event queued before a switch-off sends nothing;
  an ISO file goes PENDING → CLEAN, also with the add-on off; a file archived before its scan keeps its status; the
  sweep reads no account without the feature.

## ISO-11b · M10 · Statutory numbers exclude ISO; off switch
- **Thread title:** "ISO-11b: dashboards and reports with the ISO add-on". **Needs:** ISO-1b, ISO-2e, ISO-2f, ISO-4b,
  ISO-11e.
- **Read:** plan §4.4-4.6.
- **Paths:** `apps/api/src/modules/{dashboard,reports}/`.
- **Delivers:** portfolio, overview, breakdowns, the act-wise, department-wise and overdue reports and the
  certificate PDF read STATUTE-act instances only; `PortfolioRow.dueThisWeekFilter` carries `source: 'LAW'` when the
  feature is on (the web links are ISO-12c's); the register export follows the register: it honours `source` when
  the feature is on and leaves STANDARD instances out when it is off; the calendar takes `source` and leaves STANDARD
  out when off; ISO export kinds answer 403 on create and download when off, and the export worker re-checks the
  feature when it runs.
- **Tests:** each KPI still equals its filtered register count; an account with ISO instances keeps its statutory
  numbers; the register export with `source=ISO`, `source=LAW` and the feature off; golden counts unchanged.

## ISO-10c · M9 · ISO reminders
- **Thread title:** "ISO-10c: ISO reminders". **Needs:** ISO-10b, ISO-2e, ISO-3.
- **Read:** model §7.
- **Paths:** `apps/api/src/jobs/`, `packages/notifications/` (templates).
- **Delivers:** a daily ISO reminder run (client time, like `reminders`) that builds one `IsoNotificationInput` per
  subject, kind and anchor date (model §5.3, §7), resolving the recipients the §7 table names, calls
  `planIsoNotifications` with `ISO_REMINDER_SCHEDULE`, claims each send on `ISO_NOTIFICATION_DEDUPE_KEY`, and sends
  through `recipients(personIds, clientId)`. ISO-2b (#272) keeps the statutory send keys as they are: `ops.listDone`
  returns instance and digest rows only, so M9's `SendKey.kind` stays `NotificationKind`, and ISO rows come from the
  new `ops.listDoneIso(tx, clientId, sendDate)` as `IsoSendKey` (`isoSubjectType`, `isoSubjectId`, an
  `IsoNotificationKind`); `ops.claim`, `markSent` and `markFailed` take the subject on a `NotificationSend`. M9 adds an
  ISO send key beside `SendKey` in `apps/api/src/jobs/ports.ts` and `postgres-store.ts` methods over those, so the
  ISO run's done set comes from `listDoneIso`; `sendKeyString` in
  `apps/api/src/jobs/send.ts` appends `isoSubjectType:isoSubjectId` when they are set (it is the done-set key and the
  source of the mailer's Message-ID in `smtp-mailer.ts`, so each ISO subject gets its own); templates for the nine
  kinds; lists accounts with `listFirmIdsWithFeature('isoManagement')` (ISO-2f) and skips those not yet copied
  (`FirmTx.accountFeatures()`, ISO-10a).
- **Tests:** one person with two actions due the same day gets two emails, and a second run sends neither again;
  a `send.test.ts` case: two ISO keys that differ only in subject give different strings; time-zone tests for
  Asia/Kolkata; no reminder for closed subjects; the overdue management review repeats every 30 days.

## ISO-11d · M10 · ISO exports and ISO data in the client archive
- **Thread title:** "ISO-11d: ISO exports and the client archive". **Needs:** ISO-11b, ISO-3, ISO-3b, ISO-2h.
- **Read:** model §3.13, §5.4, §9; plan §3.3 (the review figures' exception); `docs/adr/M10-0002-client-archive.md`.
- **Paths:** `apps/api/src/modules/reports/`.
- **Delivers:** `ISO_NC_LOG_XLSX`, `ISO_RISK_REGISTER_XLSX` (with the documented significance criteria),
  `ISO_AUDIT_REPORT_PDF` (with the independence note), `ISO_REVIEW_PACK_PDF` (inputs with their figures as model §9 sets
  them: the stored copy for a HELD or CLOSED review, read and never computed; figures from `reviewInputFigures` for a
  PLANNED one, on ISO-2h's `reviewFigures.gather` (given the engine's `localDateIn` with the client's time zone) with no
  unit scope, marked as a draft; "No figures: held before the system was set up in the app" for a HELD or CLOSED one
  without them; none for a CANCELLED one; each figure worded from `REVIEW_FIGURE_KEYS`; record references only for ids
  the requester may read, through ISO-2h's `isoVisibleIds` with the requester's `UnitScope` (their membership's
  `unitIds` and their `personId`, for plan §3.3's named-person rule), built when the job runs; the INCIDENTS row's
  figures withheld, with the model §9 heading, from a requester who would not see them on screen (model §3.13 item 4);
  then outputs and actions); unit scope for everything else; no incident personal data; removes ISO-11e's refusal for
  the four kinds. The client archive always includes ISO records, each held review's stored figures with their window,
  recording time and engine version, and clean ISO files (model §9), with the NC log and risk register workbooks in its
  `iso/` folder, counting withheld files in its README.
- **Tests:** each export's content from fixtures; scope per role; refused when off; archive contents with and without
  the feature; a held review's pack prints its stored figures unchanged after a later edit, with their heading; an
  approver limited to one unit gets the same pack values as the chair, with fewer references, and the INCIDENTS figures
  withheld unless they attended; an approver who is named on a record of another unit gets its reference; the archive's
  review register carries each held review's stored figures with their window, recording time and engine version; every
  key in `REVIEW_FIGURE_KEYS` has words.

## ISO-14a · Tooling · Wire the ISO catalogue copy
- **Thread title:** "ISO-14a: wire the ISO catalogue copy". **PR title:** `Tooling: ISO ...` (no module owns these
  files). **Needs:** ISO-9, ISO-10a.
- **Why early:** until the copier is wired, switching the add-on on fails its retries and the sweep logs an error
  every 10 minutes (#277 audit Info 1). Nothing is lost, and nothing is deployed yet, but the console switch is live
  (#252). Until ISO-9b, a copied STANDARD act shows in the library even after a switch-off; that holds only for
  local demo data, and ISO-13 checks the end state.
- **Paths:** `apps/api/src/wiring.ts`, `apps/api/src/wiring.test.ts`, `apps/api/src/main.ts` if needed,
  `apps/api/CLAUDE.md` (jobs: the catalogue consumer and sweep).
- **Delivers:** `wiring.ts` passes `copyIsoCatalogue` (M6, ISO-9) to the jobs as `copyIsoCatalogue`, beside
  `copyLibrary`, through `startJobsFromEnv` (ISO-10a).
- **Tests:** `wiring.test.ts`: `jobsFromEnv` passes a copier that calls `copyIsoCatalogue` with the database, the
  account id and the request id, as the `copyLibrary` test does for `copyMasterLibrary`.

## ISO-14b · Tooling · Wire ISO files
- **Thread title:** "ISO-14b: wire ISO files". **PR title:** `Tooling: ISO ...`. **Needs:** ISO-8c, ISO-10c,
  ISO-14a, ISO-15.
- **Paths:** `apps/api/src/server.ts` (shared), `apps/api/src/main.ts` if needed, `apps/api/CLAUDE.md` (module list:
  `iso`; jobs: ISO reminders).
- **Delivers:** `server.ts` passes `createIsoFiles({ storage: options.evidenceStorage })` from M7's public index to
  M16's routes when evidence storage is configured, as it builds `createEvidenceService` (ISO-8a already mounts M16's
  routes in `server.ts`). No web change: the web app already calls the real API whenever `CANOPY_API_URL` is set.
- **Tests:** a server test that the ISO file routes mount only with evidence storage.

## ISO-13 · M14 · Integrated ISO journey and off-switch sweep
- **Thread title:** "ISO-13: ISO journey against the real stack". **Needs:** every other package.
- **Read:** plan §4, §7.
- **Paths:** `e2e/integrated/` (new ISO specs), `docs/security/review.md` if a check is added.
- **Delivers:** journey: the operator turns the add-on on; the screens show "being set up" until the copy is recorded;
  a client sets up a system, runs an internal audit, raises an NC from a finding, closes it with an action and a file
  (the file's upload, download and removal each appear in the client audit trail on its subject);
  the operator turns it off; the next request on the same session gets 403; every ISO screen shows not-turned-on; the
  console shows Off. Sweep: every `ENDPOINTS` entry called with an ISO fixture id answers 403 or returns no ISO item
  (plan §7 item 3); turning it back on shows the same data. axe on every page visited, including the operator
  console's account page with the Add-ons card open (ISO-5 shipped the drawer with no integrated or axe step).
- **Tests:** the specs themselves, in the `e2e-integrated` job.

## ISO-1c · M0 · Make the add-on's optional fields required
- **Thread title:** "ISO-1c: required add-on fields". **Needs:** ISO-1b, ISO-2c, ISO-4a, ISO-5, ISO-5b, ISO-9, ISO-16,
  ISO-3b.
- **Paths:** `packages/contracts/`, `docs/contracts/`.
- **Delivers:** a contracts bump that makes `Act.kind`, `Obligation.clauseRefs` and `AccountOverride.removedFeatures`
  required on read shapes, only where every provider sends them and every create caller in M6 and M8 sets them (or the
  create body keeps them optional). If any caller does not, the field stays optional and the PR says why. M3's
  obligation reads always return `clauseRefs`, `[]` when there are none (ISO-2c, #273). `AccountSummary.features` stays
  optional (missing = none), because `AccountView` spreads `AccountSummary` and `GET /account` does not send it (plan
  §5.1). It also narrows `IsoEngineApi.reviewInputFigures` to `TypedReviewInputFigures` (contracts 1.8.2), now that
  ISO-3b has moved the engine onto it.
- **Tests:** every package's typecheck and tests stay green (`--affected` covers them).

---

## Review trace

How v2 answers each finding of the independent review of v1 (`confirmed.md`, C1-C58).

| Finding | Where it is addressed |
|---|---|
| C1 | plan §5.1 (staging order, optional fields, `features` on `AccountSummary` only); ISO-2b, ISO-12a, ISO-1b, ISO-1c; ISO-1c keeps `AccountSummary.features` optional and needs ISO-5 and ISO-5b |
| C2 | model §6 (`iso_file`, keys, port, scan); D1 in ADR M16-0002; ISO-15, ISO-2d, ISO-10b, ISO-11d, ISO-14; plan §7 item 8; archive moved to ISO-11d |
| C3 | model §5.3, §7; ISO-1, ISO-2b, ISO-3, ISO-10c; model §5.3 (`IsoNotificationInput`, `IsoReminderSchedule`), §7 (`ISO_REMINDER_SCHEDULE`); ISO-2b (`ops.ts` `sendKey()`, `listDoneDigests`), ISO-10c (`postgres-store.ts`, `sendKeyString`) |
| C4 | plan §4.3 (event, consumer, sweep, marker); ISO-2c, ISO-5b, ISO-9, ISO-10a, ISO-14; `account.isoCatalogueCopiedAt` (ISO-2c), `AuthStore.isoCatalogueCopied` (ISO-4b), `FirmTx.accountFeatures()` with the copy time in `postgres-store.ts`, `consumers.ts` (ISO-10a) |
| C5 | plan §7 item 2 (M16's own audit gate); ISO-8a; model §6 (file audit actions); ISO-15 tests (file `AuditEvent`s); plan §7 item 2 (file rows assert the port call) |
| C6 | ISO-2a (both reads), ISO-5 (`overrideFrom`, each control its own part); plan §4.1-4.2; plan §4.1 and ISO-5 (note read from the newest `OVERRIDE_CHANGE`, `noteFrom`); ISO-5b (switch names its flag) |
| C7 | plan §4.5-4.6; ISO-1 (`source`), ISO-2f, ISO-11a, ISO-11b, ISO-11c (M12); ISO-1 (`DueThisWeekFilter.source`), ISO-12c (M13 links) |
| C8 | model §1.2, §2 (catalogue tables firm-wide, per-account copy) |
| C9 | plan §4.6; ISO-2f (`listScoreItems`), ISO-10b (digest); ISO-12c (web links), plan §4.5 M13 row |
| C10 | plan §4.4-4.5; ISO-9b, ISO-11a, ISO-11b (export kinds gated), model §9 (staged export kinds) |
| C11 | catalogue §2 (fixed values, `act_name_key` per kind, reuse on copy, import); ISO-2c, ISO-9, ISO-16; catalogue §2 `shortName` |
| C12 | plan §5.3; ISO-8a (`server.ts`), ISO-10a (`JOBS`, `start.ts`), ISO-14 (Tooling, `wiring.ts`, no web switch, `apps/api/CLAUDE.md`); ISO-13 after ISO-14; D11 for `apps/web/CLAUDE.md`; ISO-14 needs ISO-10c and passes `createIsoFiles` in `server.ts`; plan §5.3 PR list (#196, #208, #220, #239) |
| C13 | plan §5.4 (start by Needs, not plan-wave), §5.5 (thread named); MODULES.md waves note; plan §5.4-5.5 |
| C14 | ISO-1 fixtures on firm B's Northwind Foods Group, firm A untouched |
| C15 | ISO-7 (built: `FeatureNotEnabled`, `RouteDef`, mock users), ISO-6a (`iso/layout.tsx` gate), ISO-7b; ISO-6a keeps M11's `e2e/tests/shell/iso.spec.ts` green (h1, titles, off-state metadata) |
| C16 | model §5.1 (`isSignificant`, fixed scale, not editable); ISO-1 (`FirmSettings.isoRisk` with default) |
| C17 | model §5.1-5.2 file names; ISO-3 (ADR, `ENGINE_VERSION`); plan §7 item 5 |
| C18 | plan §3.2 (two-part actions, one row each, no wildcard); ISO-4b; plan §3.2 (`grantHolds` and the `Resource` per action, `isoReview.plan` split); model §4 preamble; ISO-8a (`Resource` builder) |
| C19 | catalogue §2-3 (four STANDARD acts, each activity once, minimum catalogue, overlap note); plan §2 Later; plan §7 item 12; catalogue §3 (activities assigned by the consultant, no automatic filter), §2 `shortName`; plan §7 item 12 reworded |
| C20 | model §3.3, §4.6, §5.1 (`clauseReadiness`); catalogue §4 (`assessable`, `exclusionAllowed`); plan §7 item 5; model §3.3 (`statusBeforeNa`, direct writes refused), §4.6 (REJECT_NA restores, WITHDRAW_NA); plan §3.2, §7 item 5 |
| C21 | model §4.1 (RAISE, SUBMIT_NO_ACTION, effectiveness date, back to OPEN), §3.10 (disposition, correction); plan §3.1 owner raises; model §7 effectiveness reminder; plan §7 item 6; model §4.1 (new effectiveness date and new action after VERIFY_NOT_EFFECTIVE or REOPEN), §3.10 (disposition authoriser), §4 preamble (maker-checker); plan §3.1, §7 item 6; ISO-1 tests |
| C22 | model §3.11 (incident fields, rules, personal data), §5.1 (`incidentCounts`), catalogue §5 `INCIDENTS`; plan §2 Later (LTIFR); model §3.11 (link an existing instance; creating one is Later; NEAR_MISS and lost-days rules), §6 (incident files restricted); plan §2, §7 item 8; ISO-6c, ISO-8c |
| C23 | model §3.5 (aspect and hazard fields, hierarchy, existing vs planned, override), §5.1 (`isSignificant`); model §9 (criteria printed); model §3.5 (re-rating when a treatment completes, REVIEW by owner or FA/CO/CA), §5.1 (`significant` from `rating`) |
| C24 | model §3.12 (`IsoAction` for every subject, D6); plan §2; model §3.9 (no actions on NC findings), §3.12 (open subject defined), §5.1 (OBJECTIVES gate needs a plan) |
| C25 | model §3.8 (`ExternalAudit`, certificate scope), §3.9 (finding parent), §4.4, §5.2 (`certificationCycle`), §7; model §5.2 (current cycle only, met late), §4.4 (CLOSE from HELD only without NCs); plan §7 item 5 |
| C26 | model §3.7 (checklist, cancel, report, independence note), §3.9 (finding rules), §4.3, §5.1 (`auditProgrammeCoverage`); model §5.1 (what covers a clause or unit); ISO-3 tests |
| C27 | model §3.4, §4.2 (state on the revision, REVIEW, superseded, external, availability); model §4.2 (RECORD_EDITION from DRAFT, SUBMIT refused for EXTERNAL, REVIEW needs a current revision), §6 (IN_REVIEW file locked), §7 (document review reminder to the approver) |
| C28 | model §3.4 (no RECORD type, retention), §6 (locked subjects, remove archives); plan §2 Later (retention schedule); model §1.8 (closed records read-only), §6 (CANCELLED NC final, DONE actions locked); plan §7 item 8; ISO-8a-c file routes and tests |
| C29 | model §3.13, §4.5, §5.2 (`managementReviewDue`), §7, §9; catalogue §5; model §5.4 (`reviewInputFigures`), §5.2 (`managementReviewDue` per standard, first review), §7 (overdue reminder every 30 days), §10 (`sourceFigures`); ISO-1, ISO-3, ISO-8c, ISO-11d |
| C30 | model §3.10 (source instance, similar occurrences, risk and system updates), §4.1 gates; ISO-6c (raise with instance picker); plan §2 Later (from the drawer) |
| C31 | model §3.1-3.3, §3.5, §5.1 (`climateDeterminationGaps`), §8; catalogue §4; plan §7 item 7; model §3.1 (no return to null), §5.1 (every risk kind, context item); plan §7 items 5 and 7 |
| C32 | model §3.7 (`reportedOn`), §5.1 (`certificationReadiness`); ISO-6a, ISO-8c overview; model §5.1 (RISKS gate, covered clauses and units); ISO-3; overview moved to ISO-8c, after ISO-2e's tables |
| C33 | catalogue §6 (editions as data, new edition seeded separately, move is Later); plan §2 Later; ADR M16-0002 |
| C34 | model §3.6 (`standards[]`, `riskItemIds[]`, no indicator kind); plan §2 Later |
| C35 | plan §5.4 (Needs over plan-wave, M14 overlap); MODULES.md waves note; M16/M17 Uses aligned with `needs`; MODULES.md note on `needs` corrected |
| C36 | plan §5.1; ISO-0 (staged `ISO_ENTITY_TYPES`), ISO-2b, ISO-12a, ISO-1b; ADR M16-0002 (contract bumps); plan §5.1 step 3a, ISO-11e (M10 default branch) before ISO-1b |
| C37 | D1 instead of the evidence table: model §6; `Evidence` unchanged; ISO-15, ISO-10b, ISO-11d, ISO-14; `server.ts` builds the port (ISO-14); archive in ISO-11d |
| C38 | plan §5.3; ISO-11a (M7), ISO-11b and ISO-11d (M10), ISO-11c (M12); MODULES.md module list |
| C39 | plan §5.3; ISO-14 (Tooling, before ISO-13), ISO-8a (`server.ts`), ISO-10a (jobs); plan §5.3 PR list corrected |
| C40 | ISO-1 fixtures (firm B, own file), ISO-7 (mock users), ISO-7b (header), ISO-6a needs ISO-7; ISO-12b needs ISO-7 and reads the shell model |
| C41 | ISO-2a split out (built); ISO-5 needs ISO-2a; M3 packages one at a time (plan §5.4) |
| C42 | model §7 (D4: separate `planIsoNotifications`, send-log columns and index); ISO-1, ISO-2b, ISO-3, ISO-10c; model §5.3 input types; ISO-2b names `ops.ts` functions |
| C43 | plan §4.3 (named trigger, producer, consumer, marker); ISO-5b, ISO-10a, ISO-9, ISO-14; `account.isoCatalogueCopiedAt` (ISO-2c) read by ISO-4b and ISO-10a-c |
| C44 | plan §7 item 2; ISO-8a; ISO-15 tests, ISO-13 journey, plan §7 item 2 |
| C45 | model §1.2, §2 |
| C46 | ISO-1 (`IsoEngineApi`, `FirmSettings.isoRisk`, `source`, export and notification kinds staged); ISO-11e before ISO-1b |
| C47 | plan §5.6 (D9: Tooling PRs from the planning thread, threads report drift); ISO-0 drift written into the plan |
| C48 | plan §4.4-4.5 (what ISO data is, gate table by module); ISO-9b, ISO-10b, ISO-11a, ISO-11b, ISO-11c; plan §7 item 3; MODULES.md list; scan runs on or off (plan §4.5, ISO-10b); register export follows the register (ISO-11b) |
| C49 | D1: `iso_file` with one FK column per subject and `num_nonnulls` (model §6); scan via `pendingScan` (ISO-10b); off switch on file routes (plan §4.4); plan §7 item 8; `server.ts` (model §6, ISO-14, ADR M16-0002); `db-iso-files.ts` (ISO-15) |
| C50 | model §1.2 (catalogue written only in system context); plan §4.4 (kind immutable, STANDARD only by system job, no cross-kind merges or moves); ISO-2c, ISO-9b, ISO-16; plan §7 item 11 |
| C51 | plan §3.3 (unit scope, named people, children), ISO-1 (`Resource.unitIds`), ISO-4b, ISO-8a-c; plan §7 item 9; plan §3.3 rewritten (records without a unit take the system's units), model §3.1; ISO-2d, ISO-2e, ISO-8c tests |
| C52 | plan §4.2 (one formula, next request, no cache, jobs per run); ISO-2a, ISO-2c, ISO-4a, ISO-10a; ISO-13 |
| C53 | plan §4.1 (ISO-5 keeps removals and note; known features out of the free-text field), §4.3 (event from override, plan change and plan edit); ISO-5b. The separate features endpoint was not adopted: ISO-5 had already started on the override route, and ISO-5 plus ISO-5b cover the same problems; ISO-5b: the switch always names its flag, the server keeps a flag named in neither list |
| C54 | plan §4.3 (marker usable in TRIAL and ACTIVE, sweep, `FEATURE_NOT_READY`, console flag); ISO-4c, ISO-4b, ISO-5b; plan §7 item 4; `FirmTx.accountFeatures()` returns `{ features, isoCatalogueCopiedAt }` (ISO-10a); plan §4.2 |
| C55 | model §7 (ISO send key, digest key narrowed); plan §4.2 (consumers and export worker re-check); ISO-2b, ISO-10b, ISO-10c, ISO-11b; plan §7 item 13; ISO-2b (`sendKey()`, `listDoneDigests`), ISO-10c (`sendKeyString`, Message-ID) |
| C56 | plan §5.1-5.2 (enum and error-code staging; ISO-4c before ISO-1); ISO-2b, ISO-1b; plan §5.1 step 3a, ISO-11e |
| C57 | ISO-1 (mock enforces the flag, `x-mock-features`), ISO-7 (users), ISO-7b (delegate forwards), ISO-6a and ISO-11c off-state e2e; ISO-12b needs ISO-7 |
| C58 | model §1.4-1.5 (composite FKs, join tables, `num_nonnulls`, people rule); ISO-2d, ISO-2e, ISO-8a; plan §7 item 10 |

### Contracts departures (plan v2.1)

How plan v2.1 takes in the departures ISO-1 lists in `docs/contracts/README.md` decision 51.

| Item | What the contracts do | Where it is addressed |
|---|---|---|
| a | `Certification.expiresOn` nullable, set with `issuedOn` and `certificateNumber` | model §3.8, §5.2; ISO-3 tests, ISO-6a, ISO-8a |
| b | `RiskItem.ownerId` required | as model §3.5 already had it; no change |
| c | N/A request body `{ version, reason }`, reason stored as `justification` | model §3.3, §4.6; ISO-6a |
| d | `standardIds` only grows | model §3.1; ISO-6a, ISO-8a |
| e | `RaisableNcSource` leaves out the two audit sources | model §4.1 RAISE; ISO-6c, ISO-8c |
| f | a finding's `type` moves only within its group, the NC's severity following | model §3.9; ISO-6c, ISO-8c |
| g | `IsoFile` stored form, `IsoFileView` API form; `IsoAction` one form with `subject` | as model §3.12 and §6 already had it; no change |
| h | new action `isoNc.reassign` (FA, CO, CA); NC PATCH split by field | plan §3.2 (row and note); model §4.1; ISO-4b, ISO-6c, ISO-8c; the split became two routes in ISO-1a (o) |
| i | catalogue and overview reads use `isoSystem.read` | plan §3.2 read row; model §10; ISO-8a, ISO-8c |
| j | `allowedActions` on views of records with a machine | model §10; ISO-6a, ISO-6b, ISO-6c, ISO-8a, ISO-8b, ISO-8c |
| k | ISO timing functions take `{ dueSoonDays }` | model §5.2; ISO-3 |
| l | the ISO overview route is M16's | as plan v2 (ISO-8c) already had it; model §10 says so |
| m | `approvedById` null for a recorded external edition | model §3.4, §4.2 RECORD_EDITION; ISO-6a, ISO-8a |
| n | `ExportCreateBody.kind` stays `ExportKind` until ISO-1b | ISO-1b brief |
| o | one action per route: NC reassign and review plan fields get their own routes (ISO-1a, contracts 1.8.1) | plan §3.2 (rows and note); model §4.1, §4.5, §10; ISO-1a, ISO-4b, ISO-6c, ISO-8c |

The mock's own picks where the model is silent (`docs/contracts/iso-mock.md`) are not departures; the shared rules
at the top and the ISO-3, ISO-6a-c and ISO-8a-c briefs say how those modules treat them.

### ISO-1 audit (plan v2.2)

How plan v2.2 takes in the findings of the audit of #265 (ISO-1).

| Finding | Where it is addressed |
|---|---|
| Medium 1: two-action PATCH routes leak rights through the stub `can()` | ISO-1a (one action per route, decision 51 o); plan §3.2; model §4.1, §4.5, §10; ISO-4b, ISO-6c, ISO-8c |
| Medium 2: an owner can change an NC's severity to skip corrective action | model §3.9, §3.10, §3.11, §4.1 (severity and incident outcome on the reassign route, OPEN or ROOT_CAUSE_FOUND only; a finding's type move in the same window and never by the NC's owner); plan §3.2; ISO-1a, ISO-6c, ISO-8c |
| Medium 3: `objectiveProgress` takes an `Instant` | model §5.1 (`createdOn`, `{ fyStartMonth }`); ISO-1a, ISO-3 |
| Low 1: undeclared NC and audit rules | model §3.5, §3.7, §3.10, §4.1; ISO-1a, ISO-3 (§4.1 guards), ISO-8c |
| Low 2: `approvedById` null on any approved revision | model §3.4 (no new field); ISO-1a, ISO-8a |
| Low 3: `FirmSettings.isoRisk` missing on stored rows | ISO-2b (#272, migration 0038 backfills it) |
| Low 4: `Resource.unitIds` non-empty | ISO-1a (doc comment); ISO-8a (left out for an empty unit list) |
| Low 5: owner changes without a reason | model §1.9 (decision 51 p); ISO-1a, ISO-6a, ISO-6b, ISO-6c, ISO-8a, ISO-8b, ISO-8c |
| Low 6: no catalogue regeneration test | ISO-1a |
| Low 7: the mock's sign-in ignores `x-mock-features` | ISO-1a; ISO-7b needs ISO-1a |
| Low 8: OpenAPI lacks 409 `FEATURE_NOT_READY` | ISO-1a |
| Info: STANDARD-instance events on the audit trail with the add-on off | already decided: plan §4.4 keeps ISO events on the client audit trail |
| Info: no single GET for certifications or audit programmes; the endpoints.md sync test checks paths only | left to M0; ISO-6a or ISO-6c asks the coordinator for a single GET if a screen needs one |

### Notes from audited packages (plan v2.3)

How plan v2.3 takes in what the audits of #268 (ISO-12a, merged) and #273 (ISO-2c, audited) left for later briefs.

| Note | Where it is addressed |
|---|---|
| #268 Info 1: instance events now read "(as delegate)", with no test pinning it | ISO-12d |
| #268 Info 2: state changes on the audit trail show raw codes ("State: OPEN → ACTIONS_PLANNED") | model §4.7 (one set of words for screens and the audit trail); ISO-12d; ISO-6a, ISO-6b, ISO-6c |
| #273: `account.isoCatalogueCopiedAt(tx)`, `accountJobs.markIsoCatalogueCopied(tx)` (false outside TRIAL and ACTIVE), `isoCatalogueCopiedAt` on `platformAccounts` records, `clauseRefs` always read back | ISO-5b (with the operator `accountOf` and the flag only in TRIAL or ACTIVE), ISO-9, ISO-10a, ISO-1c; plan §4.3 |
| #273 Info: staff can still edit or archive a copied STANDARD act | plan §4.4, §7 item 11; catalogue §2; ISO-9b |
| #273 Info: staff can set `clauseRefs` on any obligation without the add-on | plan §4.4, §7 item 11; catalogue §2; ISO-9b |

### Notes from audited packages (plan v2.4)

| Note | Where it is addressed |
|---|---|
| #274 audit Low: STANDARD-act edits and `clauseRefs` are refused only in the API | plan §4.4 accepts it (the 400s keep the catalogue's shape, the 403 is an off-switch gate; all are M6 route checks); ISO-9b's route tests are the guard |
| #275 audit Info: a labelled status outside the audit page's maps (an export's) would still show its code | nothing to pass on: no non-ISO event on the client trail carries an unmapped labelled code today (the export event holds `kind` and `params`; account events have no client) |
| #276 (ISO-2d): `iso_file_subject_check` and `FILE_SUBJECTS` cover only the ISO-2d subjects | ISO-2e; ISO-15 (tests on the four ISO-2d subjects) |
| #276 audit Info 1: a trigger, not a foreign key, checks `currentRevisionId`, and only when the document is written | ISO-8a (supersede, approve, then move the document, in one transaction; test it) |
| #276 audit Info 2: id lists and a certificate's standard are not checked against the catalogue or the system | model §3.8; ISO-8a (and ISO-8b, ISO-8c for their lists) |
| #276: one trigger keeps `standardIds` growing only and the climate decision from going back to null | model §3.1; ISO-8a (400 first) |
| #276: `managementSystems.create` adds no checklist rows; names `addForStandards`, `isoFiles.archive(tx, id, reason)` and the `isoCatalogue.create*` writes | model §3.1; ISO-2d, ISO-8a, ISO-9, ISO-15 |
| #276: one review definition per standard and key with one item; `exclusionAllowed` only on an assessable clause | catalogue §4, §5; ISO-9 |
| #276: `pendingScan` takes 1 to 200; `setScanStatus` checks no state | ISO-10b |
| #277 audit Info 1: until the copier is wired, a switch-on fails its retries and the sweep logs errors | ISO-14 split: ISO-14a (copier, Needs ISO-9, ISO-10a) and ISO-14b (files); plan §4.3, §5.3, §6. Earlier trace rows that name ISO-14 mean ISO-14a for the copier and ISO-14b for files |
| #277 audit Info 2: the sweep reads every account every 10 minutes | ISO-2f (`listFirmIdsWithFeature`); ISO-10b moves the sweep onto it; ISO-10c uses it; plan §4.3 |
| Plan check: six packages run while §5.4 said five | plan §5.4 (ISO-1a does not count toward the five) |

### Notes from audited packages (plan v2.5)

| Note | Where it is addressed |
|---|---|
| #271 audit Medium 1: the contract cannot carry the rebuild of a held review's figures "as the records stood on `heldOn`" (untyped `data`, no events, no time zone; model §5.4 silent) | The rebuild is dropped: a held review stores its figures once, at RECORD_HELD (ADR M16-0003; model §1.7, §3.13, §4.5, §5.4, §8, §9, §10; plan §3.3, §7 item 19); ISO-1a2 types `data` per source; ISO-1a3, ISO-2g, ISO-2h, ISO-3b, ISO-8c, ISO-11d, ISO-6c |
| #271 audit Medium 2 and Lows 3-6 (backdated `reportedOn`, records archived after `heldOn`, same-day reviews, `cancelledBy`, a local-midnight test) | model §5.4 (creation-day and archive-day rules; only held reviews set `since`; cancellation read as it is now); ISO-1a2 |
| #271 audit Lows 7-8, Info 9 (README version line, forms send only changed fields, the mock's idempotency key) | ISO-1a2 |
| #279 (ISO-9): the obligation create and update bodies are strict and have no `clauseRefs` | plan §2 (Later), §4.4, §4.5, §7 item 11; catalogue §2; ISO-9b (nothing to build, a 400 test, ADR M6-0003 amended) |
| #279: ISO-9's PR already refuses STANDARD act edits and merges and moves across kinds (400); there is no act-archive route, and the merge route refuses a STANDARD source | plan §4.4; catalogue §2; ISO-9, ISO-9b (a merge-source test) |
| #279 audit Info: ISO 14001:2026 and ISO 9001:2026 are not seeded; decide before the copy is wired in production | catalogue §6 (before any production account turns the add-on on, with a top-up for accounts that copied version 1); the package is the next plan change |
| #278 audit Info: `listFirmIdsWithFeature` reads more of `firm` than `canopy_lookup`'s `SELECT (id)` | ISO-2f: owned by `canopy_lookup`, column grants only, never a whole row, ids only (#282) |
| #280 audit Info 1: `review_input_def_key` and `review_output_def_key` are not partial, and nothing archives review rows | model §3.13 (rows follow the review's standards); ISO-2g (partial keys and the arbiter), ISO-2h (`syncForReview`); ISO-8c |
| #280 audit Info 2: the NC number trigger needs READ COMMITTED | ISO-8c |
| #280: cross-row rules left to M16 (lead not an auditor, a checklist row's finding in the same audit, a control's action on its risk item, standards among the system's, ids in the catalogue) | ISO-8a (ids), ISO-8b (controls, objectives), ISO-8c (lead, checklist findings, NC and review standards) |
| #281 audit Info: M5's unit rule holds only if M16 builds `Resource.unitIds` as plan §3.3 says and lists, counts and exports use the same rule | ISO-8a, ISO-8b, ISO-8c (a test that `can()` and the list SQL agree for each record kind) |
| #284 (ISO-1a2): ISO-3's engine (#270) declares its own per-source types, so a typed `IsoEngineApi.reviewInputFigures` in 1.8.2 breaks its `satisfies` | ISO-1a2 keeps the wide signature and exports `TypedReviewInputFigures`; ISO-3b adopts it; ISO-1c narrows the signature |
| Self-check of v2.5 before its PR: backdated audit and action dates fall between two reviews; PREVIOUS_ACTIONS counts cumulatively; a review held before set-up stores zeros; no list of figure keys; RISKS kinds and findings not filtered by standard | model §3.13, §5.4; ISO-1a3 (left out of #284 by agreement), ISO-3b, ISO-2h |
| Self-check: a stored row could still be archived or repointed; M16 and M10 would each gather the figures; `isoVisibleIds` undefined for instances and whole-client readers; ADR M6-0003 still expects `clauseRefs` in the bodies; the review figures' exception not named for incidents | model §3.11, §3.13; plan §3.3, §7 items 9 and 19; ISO-2g (row guard, its own migration PR), ISO-2h (gather, visible ids); ISO-9b (ADR amendment) |

### Notes from audited packages and the check of v2.5 (plan v2.5.1)

| Note | Where it is addressed |
|---|---|
| #291 audit Low: a review's figures show other units' incident outcomes and lost days to a reader limited to some units | model §3.11, §3.13 item 4, §9; plan §3.3, §7 items 9 and 19; ADR M16-0003 decision 3; ISO-1a3 (`figuresWithheld`), ISO-8c, ISO-11d, ISO-6c |
| #291 audit Info: the step that retakes stored figures is Later with no bound | plan §2 (Later; until then a correction goes in notes); model §3.13 item 6; ADR M16-0003 consequences |
| Check of v2.5: an incident raised, an objective closed, a climate decision taken or an external finding entered after a review, but dated before it, fell between two reviews | model §5.4 (step days for objectives and the climate decision; incidents and findings placed through their NC or audit); ISO-1a3, ISO-3b, ISO-2h |
| Check of v2.5: risk kinds chosen by standard made a 14001 review's two RISKS rows count the same items | model §5.4 (kinds by input key); catalogue §5; ISO-1a3, ISO-2h |
| Check of v2.5: the window's first day counts again what the earlier review counted that day | model §5.4 (stated; the stored ids show it); plan §2 (Later) |
| Check of v2.5: overdue corrective actions on cancelled NCs left to the mock only | ISO-3b (the engine counts only NCs open on `asOf`) |
| Check of v2.5: no brief writes the residual-clear event that the figures rely on | ISO-8b (reads model §8; the UPDATE with `sourceActionId`; a test) |
| Check of v2.5: `packages/db` cannot call the engine's `localDateIn` | ISO-2h (`gather` takes the caller's `localDay`); ISO-8c, ISO-11d pass it; model §5.4 |
| Check of v2.5: "N (M you can open)" misreads keys whose value is not a count of ids; the archive's figures lack their window, time and engine; the pack's scope drops the named person; the exception belongs in endpoints §10 | ISO-1a3 (`REVIEW_FIGURE_KEYS` says which keys count ids; endpoints §10), ISO-6c; model §9, ISO-11d |
| Check of v2.5: ISO-6a and ISO-11c had started but showed no status | plan §6 (and ISO-1b, started) |
