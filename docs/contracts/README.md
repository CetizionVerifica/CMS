# Canopy contracts v1 (module M0)

The shared shapes every module builds against. These files describe them; the code in `packages/contracts` is the
source of truth wherever it exists. Shipped in code so far: domain types, enums, entity Zod schemas, error codes, request/response
schemas for every endpoint with role permissions (`packages/contracts/src/api`), the generated OpenAPI 3.1 spec
([openapi.json](openapi.json)), typed JSON fixtures for firms A and B (`packages/contracts/fixtures`) and a mock
API server that serves every endpoint from those fixtures (`@canopy/contracts/mock`). Since 1.8.0 that includes the
ISO add-on (M16): its records, engine interface, 117 routes, catalogue and firm B's ISO fixture.

| File | What it fixes | Main readers |
|---|---|---|
| [domain-model.md](domain-model.md) | Primitives, enums, entities, recurrence rule shape, state machine, import model, score types, `can()` signature | everyone |
| [api-conventions.md](api-conventions.md) | Paths, auth, concurrency, pagination, filters, error envelope and codes, files, versioning | M5-M13 |
| [endpoints.md](endpoints.md) | Every endpoint per provider module with role permissions | M5, M6, M7, M8, M10, M15, M16 (provide), M11-M13, M17 (consume) |
| [openapi.json](openapi.json) | OpenAPI 3.1, generated from the endpoint table in code; do not edit | M5-M13, the mock server |
| [events.md](events.md) | Domain event envelope and catalogue with payloads | M9, M10 and every producer |
| [fixtures.md](fixtures.md) | Fixture files, golden counts and scores recomputed from the sample, firm B spec, the ISO catalogue and firm B's ISO data | M3, M4, M8, M10, M12-M14, M16, M17 |
| [CHANGELOG.md](CHANGELOG.md) | Contract versions | everyone |

## Status
Version `1.8.0` (`CONTRACTS_VERSION` in `packages/contracts/src/version.ts`). The domain model in §1-8 of
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
8. Entity schemas are strict (unknown keys rejected, enums closed, enum-keyed records exhaustive) so fixtures, seeds and
   server-side writes cannot carry typos. That is deliberately stricter than api-conventions.md §7, which lets the API
   add fields and enum values without a version bump. Clients must not parse responses with these entity schemas: they parse with
   `tolerant(schema)`, which accepts unknown fields, unknown enum values (shown as "Unknown") and extra record keys.
9. `jurisdiction: CENTRAL` has `stateCode: null`; `STATE` needs one. This holds for Acts and obligations.
10. A person's email follows status: `UNCLAIMED` has none, `INVITED` and `ACTIVE` need one, `DISABLED` may have either.
11. Membership shape follows role: firm roles have no `clientId`, client roles need one; only `CONSULTANT` has
    `consultantClientIds` (required); only `OWNER`/`APPROVER` may have `unitIds` (non-empty, or null for all units);
    `VIEWER` needs `expiresAt`.
12. Instance consistency: `pendingKind` is set exactly while `SUBMITTED`; `completedOn` is required for `APPROVED`,
    `NOT_APPLICABLE` and a `COMPLETION` submission; `naReason` for `NOT_APPLICABLE` and an `NA` submission;
    `periodEnd >= periodStart`.
13. `ScoreResult.onTimeRate` is a percentage with one decimal like `score` (0-100), not a 0-1 fraction.
    `counts[s]` always equals `instanceIds[s].length`, and an `InstanceRow` has `overdueDays` exactly when its status is
    `OVERDUE`. At least one criticality weight must be above zero.
14. An `ImportIssue`'s severity is fixed by its type (the table in domain-model.md §6), and `editedValue` is set exactly
    when the decision is `EDITED`.
15. `ImportRow` and `ImportIssue` carry no `firmId` in the API shape: they are always read through their batch, which
    does. Their tables still need `firm_id` and an RLS policy like every other client-data table (root CLAUDE.md
    non-negotiable 1); M3 adds the column.
16. Clients parse every response with `tolerant(endpoint.response)`. It keeps unknown keys, reads an unknown enum value
    as `"UNKNOWN"`, reads an object with an unknown discriminator (a new recurrence kind) as `{ kind: "UNKNOWN" }`,
    accepts extra keys in enum-keyed records and drops cross-field rules; wrong types in known fields still fail.
17. Every list response is an object (`{ items, nextCursor, total? }` for pages, `{ items }` for complete lists), never
    a bare array, so fields can be added. This changed the calendar and portfolio responses in endpoints.md §6.
18. `POST /clients/{clientId}/imports` returns `{ batchId, url, headers, expiresAt }`. The batch becomes readable at
    `POST /imports/{id}/uploaded`, which records the hash, so `ImportBatch.fileSha256` is never empty.
19. `can()` action names are `<resource>.<verb>` in lower camelCase (`Action`), e.g. `instance.dueDate`. Import actions are
    `import.read`, `import.create`, `import.write` and `import.commit`.
20. Bulk create (`/assignments/bulk`) reports results by request `index`; bulk approve reports them by instance `id`.
21. Login, magic-link verify, MFA verify and invite accept all return `Me`, so the client has the CSRF token at once.
    The session cookie is `canopy_session`. Passwords are 12-200 characters; invite links last 7 days. M5 may change
    these through a contract change.
22. `Invite` and `InviteStatus` (PENDING, ACCEPTED, REVOKED, EXPIRED) are defined with the API, since the domain model had
    no invite entity. An invite names an existing person (e.g. an UNCLAIMED owner from an import) or a new one.
23. `error.details` has a fixed shape per code (`ERROR_DETAILS`, `ApiErrorResponse`); codes without details send none.
24. A `PATCH` must change something besides `version`, else `400 VALIDATION`. `PUT /clients/{clientId}/settings` takes
    either `settings` or, for a CLIENT_ADMIN, only `reminders`.
25. The overdue report returns `{ result, items }`: the ScoreResult and the overdue rows.
26. `GET /me` gives each client its FY start, time zone, the units the person can see and the periods the picker offers
    (`ClientPeriods`: current FY and quarter, FYs with generated instances, last generated month), computed by the
    server with the engine, so the web app does no FY maths.
27. `POST /clients/{clientId}/people` takes `role` (OWNER, APPROVER or CLIENT_ADMIN; default OWNER) and creates a
    membership on every unit, so the person belongs to the client under RLS. VIEWERs come through an invite.
28. A person with an email is INVITED even before an invite is sent; removing the email makes an INVITED person
    UNCLAIMED again. An ACTIVE person cannot have their email cleared (`400 VALIDATION` on `email`); a DISABLED person
    keeps their status either way. This keeps the status rule M3's `person_email_status_check` enforces.
29. `instance.generated` is one event per created instance with `aggregateVersion: 1`, so an instance's events count
    up from its creation; there is no per-run summary event.
30. Fixture periods: firm A's instances get `periodStart`/`periodEnd` from the rule stored on the obligation (quarter or
    month ending on the due date for ongoing reviews, the month before for monthly returns, the FY for annual dates,
    equal FY slices otherwise). Firm A obligations whose dates no simple rule reproduces store `FIXED_DATES` and
    `ruleStatus: TO_REVIEW`. M4's golden test asserts due dates, not these periods.
31. Firm A carries two firm staff besides the 21 register people: a FIRM_ADMIN and a CONSULTANT, with
    `@demo-advisory.example` emails. Register people are UNCLAIMED with no email. Owners are "Owner 01"-"Owner 12" and
    people who only approve are "Approver 01"-"Approver 09", numbered by normalised real name; the generator fails if
    any real name, or a part of one, appears in copied text.
32. For the `raw` profile the complied row with no Activity Date still counts as APPROVED with `completedOn = dueDate`;
    "raw" means no merges are accepted, not that the row is left invalid.
33. Mock sign-in: any password signs in an ACTIVE person, any six digits pass MFA, and magic links land in
    `GET /__mock/outbox`. Tests and scripts can skip the session with an `X-Mock-Person` header (person id or email),
    which also skips CSRF and MFA. Nothing is logged, since URLs can carry invite tokens.
34. Mock "today" is the real date unless pinned (`createMockServer({ today })` or `MOCK_TODAY`). Firm roles reproduce firm A's
    golden scores by passing each row's `asOf`; firm B's states are built around 2024-11-15.
35. The mock derives status and scores with a plain test double (`src/mock/derive.ts`, `engineVersion: "mock-1"`), not
    the engine. It matches fixtures.md for the fixtures; anything finer belongs to M4, and the real API calls the engine.
36. Mock imports run the whole state machine on a canned parse of the sample register (`ASPxGridView1`, the §3 issue
    groups) whatever file is uploaded; commit reports dry-run counts but does not write rows. A new assignment gets
    instances for every period of the client's current FY.
37. Mock evidence: the virus scan finishes on the next read, and a file name containing "eicar" comes back INFECTED.
    File URLs point at `https://files.mock.invalid` and are never fetched.
38. Login answers `Me` on success whatever the firm count. An email that signs in to several firms gets 409
    `FIRM_CHOICE_REQUIRED` listing them (only after the password matched in each), and the client retries with
    `firmId`. Login does not apply the password policy, so an old password that predates a stricter policy still works.
39. Accounts (contracts 1.5.0, ADR M15-0001). `Firm.kind`, `status`, `planCode` and `trialEndsOn` default to an active
    consultancy, so firm rows stored before M3 adds the columns still parse; `Me.account` is optional for the same
    reason, and a client reads a missing one as `DEFAULT_ACCOUNT`. The operator API is a second table,
    `PLATFORM_ENDPOINTS`, with its own OpenAPI document (`openapi.platform.json`) and no roles. `AuditActorKind`
    `OPERATOR` and `EntityType` `account` are left for a later bump: they are Postgres enums, so they land with M3's
    migration (as `NotificationKind` did in 1.4.0). The mock serves `/account` and support grants for firm A and B (both
    active consultancies, unlimited) and `POST /__mock/support-sessions/{grantId}` stands in for the console.
    The operator never sees personal data (ADR M15-0001 decision 8): `Account` has no owner name or email, and the
    operator's grant list is `OperatorSupportGrant`, without person ids. A trial extension is its own route
    (`POST /accounts/{id}/trial`), not a status move, so every move the status body allows passes `canMoveAccount`.
    The support person is marked `Person.support` (optional, absent = false), never matched by name; the mock refuses
    it password sign-in, magic links and invites, expires console tokens after `SUPPORT_TOKEN_SECONDS`, ends support
    sessions at the earlier of 2 hours and the grant end, and audits each support membership granted or ended as
    `MEMBERSHIP_CHANGE`. Like every mock handler, it keeps no domain-event outbox.
40. Account reminder schedules (contracts 1.6.1, ADR M15-0001 order of work step 6) are defaults, not fixed by the
    ADR: `TRIAL_ENDING` goes 7 days and 1 day before `trialEndsOn`, and `RENEWAL_DUE` 30 days and 7 days before the
    latest paid subscription ends. Changing the offsets changes no schema; M9 owns the schedule.
41. Add-ons (contracts 1.7.0, ADR M16-0001, `docs/iso/plan.md` ISO-0). New fields are optional so this bump merges
    before their providers send them: `AccountOverride.removedFeatures` and `Me.account.features` (a reader treats a
    missing list as empty), `Act.kind` (missing reads as `STATUTE`) and `Obligation.clauseRefs` (missing reads as
    empty); later patches make them required once M3 stores and M5 sends them. A `STANDARD` act is `CENTRAL` with no
    state code rather than a new jurisdiction, and the library's create and update bodies take no `kind`: only the ISO
    catalogue (M6, as code) creates STANDARD acts. The ISO entity types are staged in `ISO_ENTITY_TYPES` and join
    `EntityType` in a later bump, after M3's migration and the audit page's words, as `account` did (decision 39).
    The mock gives firm B (Second Ledger Consulting, whose people cover every role) `isoManagement` and firm A none, and
    `PUT /__mock/firms/{firmId}/features` `{ features }` stands in for the console's switches until the next reset.
42. ISO contracts (contracts 1.8.0, ADR M16-0002, `docs/iso/packages.md` ISO-1). The shapes follow `docs/iso/model.md`
    v2: the catalogue rows, every client record, the eight machines, `IsoFile`, the engine results and `IsoEngineApi`
    (domain-model.md §10). `ISO_ENTITY_TYPES` is replaced by the v2 list of 18 before anything stores it:
    `corrective_action` and `review_action` became one `iso_action`, and `external_audit`, `risk_control` and
    `audit_checklist_item` are new. `ISO_NOTIFICATION_KINDS` and `ISO_EXPORT_KINDS` are new and staged the same way.
    None of the three joins `EntityType`, `NotificationKind` or `ExportKind` here, because those are Postgres enums
    (plan §5.1): they join in ISO-1b, after M3 stores them, M13 has words for the entity types and M10's export
    builder takes new kinds. Until then no route writes an `AuditEvent` with an ISO entity type, no `can()` resource
    names one, and `ExportCreateBody` refuses the ISO export kinds. New fields on existing shapes are optional or
    defaulted (`Resource.unitIds`, `DueThisWeekFilter.source`, `Account.isoCatalogueCopiedAt`, `FirmSettings.isoRisk`
    with `DEFAULT_ISO_RISK_RULE`), so stored rows keep parsing and providers keep compiling. `EngineApi` and
    `PlannedNotification` do not change: the ISO engine is its own interface, and ISO reminders have their own shapes,
    schedule (`ISO_REMINDER_SCHEDULE`) and send key (`ISO_NOTIFICATION_DEDUPE_KEY`), since ISO records are not
    instances.
43. `Obligation.clauseRefs` changes from clause numbers to `{ standard, clauseNumber }[]` (`ClauseRef`; at most 20,
    unique per standard and number, still optional). A bare number cannot say which standard it belongs to: 9001 8.2
    and 14001 8.2 are different clauses. Nothing breaks: no provider sent a non-empty list under 1.7.0, and M3
    already stores the object form, leaving it out of reads and refusing a non-empty value on writes until ISO-2c
    reads and writes this shape. The catalogue's activities carry their references in it too.
44. ISO roles and actions (plan §3.2 as implemented, endpoints.md §10). Each ISO resource has a `<resource>.read`
    action and the write actions of the plan's table, so M5 adds one `POLICY` row per action and no wildcard. All
    117 routes are M16's and carry `feature: 'isoManagement'` (`x-canopy-feature` in OpenAPI). ISO routes use only
    `all` and `own` access. "own" is the person named in that role on the record (owner, approver, lead auditor or
    auditor, chair); where "own" names someone other than an owner or approver, M16 sets both `ownerId` and
    `approverId` to the actor when the actor is one of them. FA, CO and CA may take a step the named person normally
    takes, audited with `delegated: true`; FA and CO never take an approver's step; nobody takes a checker step on a
    record where they took a maker step since its last RAISE, REOPEN, VERIFY_NOT_EFFECTIVE or DRAFT_REVISION (`403
    FORBIDDEN`). Views of records with a machine carry `allowedActions` for the signed-in person. The changes to the
    plan's table are in decision 51.
45. ISO unit scope (plan §3.3). An approver or owner whose membership lists units sees an ISO record when its unit is
    theirs, its units list overlaps theirs, it has no unit and its management system's units qualify, or it names
    them. An empty units list on a management system means every unit of the client; on an internal audit or
    certificate, its system's units. A child record takes its parent's units, and the current approved revision of a
    system document stays readable by every member of the client. Outside scope a single read or write is `404`, and
    lists, overview counts and exports leave the record out. `can()` checks the unit part through the new optional
    `Resource.unitIds` (non-empty, distinct): when present, a unit-scoped membership needs one of those units. The
    stub's `inScope` does this now and M5's does in ISO-4b; the named-person exception stays the provider's check.
46. The ISO feature gate. Every ISO route answers `403 FEATURE_NOT_ENABLED { feature }` without the add-on, reads and
    files included, and `409 FEATURE_NOT_READY { feature }` while the account has it but its catalogue copy is not
    recorded (`Account.isoCatalogueCopiedAt` null, plan §4.3). `FEATURE_NOT_READY` is a new code: the request is
    sound but the account is not set up yet, so a retry later succeeds; M5's message for it landed first (ISO-4c).
    Both come after the session, MFA and CSRF checks and before input validation. Off hides and refuses, never
    deletes: core lists leave STANDARD items out, a core route that names one by id answers the same 403 after its
    404 and role checks (so someone who cannot see the item still gets 404), and bulk approve refuses them per item.
    `account.features_changed` (events.md) tells M9 to run the copy. `ERROR_DETAILS.INVALID_TRANSITION` gains
    `{ entity, from, action }` for the ISO machines, with `action: 'UPDATE'` for a field edit, list change, new child
    row or file change on a locked record.
47. `source` and statutory numbers (plan §4.6). `ActivitySource` (`LAW` = STATUTE acts, `ISO` = STANDARD acts,
    absent = both) is on the register filters, so `RegisterQuery`, `RegisterFilterQuery` and the register export get
    it, and on `/me/approvals`, `/me/tasks`, the vault and the calendar. Without the add-on STANDARD items are left out
    whatever `source` says. Scores, KPIs, breakdowns, reports, the certificate and the digest count STATUTE acts only,
    on or off, so an ISO activity never moves a statutory figure. With the add-on on, `dueThisWeekFilter.source` is
    `LAW`, so a portfolio number equals the list its link opens. ISO has its own figures in the ISO overview.
48. ISO files are kept apart from evidence (`iso_file`, model §6). `Evidence`, `EvidenceView`, the vault and
    `/evidence/{id}/*` do not change, so no evidence reader can show an ISO file, and the instance rule that managers
    may remove evidence in any state does not carry over: a file is added or removed only while its subject is open.
    `IsoFile` is the stored form, with one nullable column per subject (`ISO_FILE_SUBJECT_COLUMNS`, 11) so M3 can use
    composite foreign keys and `CHECK num_nonnulls = 1`, and `storageKey`; the API returns `IsoFileView`, with
    `subject: { type, id }` and no `storageKey`, as `EvidenceView` drops it. File types, the 25 MB limit, the scan,
    CLEAN-only downloads, 5-minute URLs and the audit actions are the evidence ones, on the subject's entity type.
    Files of an incident nonconformity and its actions download only for the people model §6 names.
49. The mock serves every ISO route and enforces the gate as the real API does.
    `X-Mock-Features` (comma-separated flags, empty = none) replaces the firm's features for one request,
    `Me.account.features` and every gate included, so the web mock can play a demo user without the add-on (ISO-7b);
    a value that is not a list of flags is `400 VALIDATION`. `PUT /__mock/firms/{firmId}/features` now takes
    `{ features, isoCatalogueCopied? }` and answers `{ features, isoCatalogueCopiedAt }` (`404` for an unknown firm,
    `400` for a bad body). Turning `isoManagement` on runs the catalogue copy unless `isoCatalogueCopied` is false,
    which leaves an account that was never copied answering `409 FEATURE_NOT_READY`; false never clears a copy
    already recorded (a reset does). The copy writes the catalogue tables, reuses a live STANDARD act or a live
    category of the same name, adds the obligations, records itself once and, when a route runs it, writes a SYSTEM
    `CREATE` audit event per act, category and obligation it adds; the fixture load writes none. ISO audit events
    are kept apart from the register's while their entity types are staged (decision 42), so the client audit trail
    does not list them before ISO-1b; a delegated step has `delegated: true` in `after`. ISO statuses and figures come
    from the mock's test double (`src/mock/iso/derive.ts`), as decision 35 says for instances. As in decision 37, a
    confirmed ISO file is PENDING and is CLEAN on the next read of its subject's files or of a download URL, and a
    name containing "eicar" comes back INFECTED. Core routes apply the off switch and `source` (decisions 46-47).
50. ISO fixtures (fixtures.md §8). `iso.catalogue.json` holds the catalogue without ids. `isoCatalogueRows(firmId, at)`
    turns it into one account's rows with UUIDv5 ids of `<firmId>:<key>` in `ISO_CATALOGUE_NAMESPACE`
    (`isoCatalogueId`, `isoClauseId`), so two accounts' copies never share an id and every load gives the same ones.
    `firm-b.iso.json` is firm B's Northwind Foods Group: one integrated system on all three standards with every record
    kind in its states, and 7 STANDARD assignments with 34 instances; it holds no catalogue rows, which the store
    makes from its `catalogueCopiedAt`. Firm B starts with `isoManagement` on and its copy recorded; Harbour Retail
    Group and firm A get no ISO rows, so firm A's golden numbers and firm B's existing counts do not change. The
    STANDARD instances are placed so that no web journey against the mock changes: none waits in Nisha's approvals,
    Rohan's earliest open rows and the vault's newest file stay statutory, and nothing falls due in the portfolio's
    week.
51. Departures from `docs/iso/model.md` and plan §3.2, each checked against the code:
    (a) `Certification.expiresOn` is nullable and set exactly with `issuedOn` and `certificateNumber` (model §3.8 has
    it required), so a certificate being pursued can be recorded before it is issued; its cycle is empty until then.
    (b) `RiskItem.ownerId` is required, as model §3.5 has it (an earlier draft of ISO-1 made it nullable): `ISO_REVIEW_DUE`
    goes to the owner, and an owner's `own` grant needs one.
    (c) `ClauseNaRequestBody` is `{ version, reason }`: the reason is stored as the row's `justification`, so a request
    without one is `422 REASON_REQUIRED`, as for every other N/A request, rather than a field of its own.
    (d) `ManagementSystemUpdateBody.standardIds` may only grow. An added standard gets its checklist rows; dropping
    one is `400 VALIDATION`, since its checklist rows, certificates and reviews would lose their standard.
    (e) `RaisableNcSource` leaves out `INTERNAL_AUDIT` and `EXTERNAL_AUDIT`: those nonconformities are raised only by
    recording a MAJOR_NC or MINOR_NC finding, in the same transaction, so each has its finding.
    (f) A finding's `type` moves only among OBSERVATION, OFI and GOOD_PRACTICE (GOOD_PRACTICE only while it has no
    actions that are not cancelled), or between MAJOR_NC and MINOR_NC with the nonconformity's severity following
    (`409 INVALID_TRANSITION` once that nonconformity is CLOSED or CANCELLED). Other moves are `400 VALIDATION`:
    record a new finding instead of turning one into an NC, and cancel the NC instead of turning an NC finding into
    another type. So a finding and its nonconformity never come apart.
    (g) `IsoFile` is the stored form with 11 subject columns and `IsoFileView` the API form with `subject` (decision
    48), because the file row holds a `storageKey` the API never returns, as `Evidence` and `EvidenceView`.
    `IsoAction` has nothing to hide, so it has one form, with `subject: { type, id }` as model §3.12 says the
    contract shows it; M3 maps its five subject columns to that.
    (h) `isoNc.reassign` (FA, CO, CA) is a new action for a nonconformity's owner, approver, `dueOn` and
    `effectivenessDueOn`, with a reason (audited `REASSIGN` or `DUE_DATE_CHANGE`). The plan's table has no row for it,
    and `isoNc.work` (CA, OW own) would let an owner reassign their own nonconformity. The PATCH route lists FA, CO,
    CA and OW (own): FA and CO may change only these fields, and OW only the investigation fields.
    (i) The catalogue and overview reads use `isoSystem.read`: the catalogue is the account's reference data and the
    overview spans every resource, so neither has a resource of its own. Every role may read them.
    (j) Views of records with a machine carry `allowedActions` (model §10 does not list them), so the UI shows only
    the steps the person may take, as `InstanceDetail` does.
    (k) `nonconformityStatus`, `actionStatus`, `managementReviewDue` and `reviewDue` take `{ dueSoonDays }`, which
    model §5.2 leaves out, so DUE_SOON means the same as on the register (`FirmSettings.dueSoonDays`).
    (l) The ISO overview route is M16's, as plan v2 (ISO-8c) has it; an earlier draft of ISO-1 gave it to M10.
    (m) `DocumentRevision.approvedById` is null for a recorded edition of an EXTERNAL document, while `approvedAt` is
    still set: the issuer approved it, not a person in the client.
    (n) `ExportCreateBody.kind` stays `ExportKind` rather than taking `IsoExportKind` too, so it refuses the ISO kinds
    until ISO-1b joins them. Its filter check already goes through `exportFilterQuery(kind)`, which
    picks `ISO_EXPORT_FILTERS[kind]` for an ISO kind, so ISO-1b changes no schema there.
