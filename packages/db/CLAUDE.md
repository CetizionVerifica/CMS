# packages/db: schema, tenancy, migrations

PostgreSQL 16 with Drizzle ORM. Root `CLAUDE.md` applies.

## Tables (v1)

Tenancy and people

- `firm` (consultancy tenant), `client` (org group, e.g. "Kestrel Metals Group"), `company` ("Kestrel Aluminium"), `unit` ("Plant", with `location_id`)
- `location` (country, state, city; state drives state-law applicability, e.g. West Bengal)
- `person` (name, email, `name_normalized` for dedupe, `status` e.g. unclaimed/active/disabled), `membership` (person × firm or client, role, `consultant_client_ids`, `unit_ids`, `expires_at`), `department` (per client, with `aliases text[]`)

Library

- `act` (name, short name, jurisdiction `CENTRAL | STATE`, state code, `aliases text[]`, `kind` `STATUTE | STANDARD`;
  a STANDARD act is CENTRAL, ADR M16-0001; the name is unique per firm and kind among non-archived acts; only the
  system job inserts a STANDARD act, and a trigger refuses any change of kind, whatever the role)
- `obligation` (`external_ref` e.g. "TAX-CL-033-6067-60218", `domain`, `jurisdiction`, title, description, `category_id`, `criticality`, `timeline_type`, `recurrence_rule jsonb` validated by the engine schema, `applicability_text`, `forms jsonb`, `log_sheets jsonb`, `evidence_required`, `rule_status`, `library_version`,
  `clause_refs jsonb` of `{ standard, clauseNumber }` objects, never bare numbers, read and written as the contract's
  `clauseRefs`)
- `category` (name, `aliases text[]`)

Work

- `assignment` (obligation × unit × department, `default_owner_id`, `default_approver_id`, `applicability` `APPLICABLE | NOT_APPLICABLE | TO_ASSESS`, `na_reason`, active from/to)
- `compliance_instance` (`assignment_id`, `period_start`, `period_end`, `due_date date`, `workflow_state`, `pending_kind`, `completed_on date`, `na_reason`, `due_date_overridden`, `version`, `owner_id`, `approver_id`, `submitted_at`, `approved_at`, unique `(assignment_id, period_start)`)
- `evidence` (instance, storage key, file name, size, mime, sha256, scan status, uploaded by), `comment` (instance, author, body)
- `audit_event` (append-only: actor, action, entity, entity id, before jsonb, after jsonb, at, request id)
- `import_batch`, `import_row` (raw row jsonb, mapped jsonb, outcome), `import_issue` (per row/field issue and resolution) and `mapping_template` (saved column mappings per client) for traceable imports
- `domain_event` (transactional outbox for the event catalogue), `export_job` (Excel/PDF exports), `notification_send` (send log: scheduled sends unique per instance, kind, send date and recipient; ISO reminders, with `iso_subject_type` and `iso_subject_id` and never an instance, unique per subject, kind, send date and recipient; event-driven sends, with `event_id`, unique per event and recipient; only these and account sends may have a null `client_id`, seen by firm-wide contexts only)
- `idempotency_key` (M7's Idempotency-Key replay: the first response per person and key, until `expires_at`)

Sign-in (M5)

- `auth_credential` (password hash, sealed MFA secret, failed attempts, lock), `auth_session` (token hash, CSRF token, MFA flag),
  `auth_invite` (the membership to grant), `auth_token` (magic-link and invite links by token hash). ADR M3-0001.

Accounts and the operator (M15)

- `firm` is also the customer account: `kind`, `status`, `plan_code`, `trial_ends_on`, `onboarded_at`,
  `deletion_requested_at`, `status_before_deletion`, `iso_catalogue_copied_at` (set once by
  `app_mark_iso_catalogue_copied()`, docs/iso/plan.md §4.3), and `profile jsonb` (legal name, GSTIN, time zone, FY start
  month; `AccountProfile` in contracts). The app role may update only `name`, `settings` and `version`.
- `support_grant` (PlanetPulse support access an account admin grants; tenant table). `person.support` marks the
  support person, who is never a sign-in candidate; `auth_session` and `auth_token` carry `support_grant_id`.
- Schema `platform` (no `firm_id`, no RLS, no access for `canopy_app`): `plan`, `account_override` (features added
  and `removed_features`; effective features are (plan ∪ added) − removed, computed only by
  `canopy_effective_features()`, which `app_account()` and `platformAccounts.entitlements` both call), `operator`,
  `operator_credential`, `operator_session`, `subscription`, `usage_snapshot`, `operator_audit_event` (append-only for
  every role). ADR M15-0001, M3-0002.

ISO add-on, part 1 (ISO-2d, migration 0040; docs/iso/model.md §1-3.4, §3.8, §6)

- Catalogue, the account's own copy, firm-wide; every context reads it, only a system job (`app_system_job()`) inserts or
  updates it: `iso_standard` (code, edition), `iso_clause` (number, title, our own summary, parent, `hls_key`,
  `assessable`, `exclusion_allowed`), `iso_review_input_def`, `iso_review_output_def`. Numbers and our words only.
- Client records (`client_id`, client policy, a `(firm_id, client_id, id)` key, so a reference never leaves the client):
  `management_system` (`standard_ids uuid[]`, which only grow, and a climate decision that never returns to null: a
  trigger), `management_system_unit` and `certification_unit` (join rows, archived when a unit is removed, a partial
  key on live rows), `context_item`, `clause_assessment` (one per system and clause; the contracts' N/A rules as
  checks), `controlled_document` (code unique per client; `current_revision_id` names an APPROVED revision of the
  document, checked by a trigger, not a foreign key, so the purge can delete both), `document_revision` (one DRAFT or
  IN_REVIEW and one APPROVED per document), `certification`, `external_audit`.
- `iso_file`: ISO files, never in `evidence`. One nullable subject column per subject with `num_nonnulls(...) = 1`
  (all eleven subjects of model §6 since ISO-2e); `storage_key` inside `evidence/<firmId>/<clientId>/iso/`; removed files keep the row with `remove_reason`.
- Repositories (`repositories/iso.ts`): `isoCatalogue`, `managementSystems`, `contextItems`, `clauseAssessments`
  (`addForStandards` adds the NOT_STARTED rows), `controlledDocuments`, `documentRevisions`, `certifications`,
  `externalAudits`, `isoFiles` (`create`, `get`, `forSubject`, `pendingScan`, `setScanStatus`, `archive`,
  `cleanForClient`). Lists take a `UnitScope` (`unitIds`, `personId`) and apply plan §3.3 in SQL. None checks a role,
  the feature switch or a state machine: M16 does.

ISO add-on, part 2 (ISO-2e, migration 0041; docs/iso/model.md §3.5-3.13)

- Client records, as in part 1: `risk_item` (the contracts' kind rules as checks; `rating`, `residual_rating` and
  `significant` stored from the engine), `risk_control`, `objective` (`standards` as standard codes), `objective_reading`,
  `audit_programme` (one per system and FY), `internal_audit` (lead as a column), `audit_checklist_item`,
  `audit_finding` (exactly one of internal or external audit; an NC link exactly for MAJOR_NC and MINOR_NC, one finding
  per NC), `nonconformity` (incident fields as `incident_*` columns, set exactly for INCIDENT and NEAR_MISS; composite
  keys to `compliance_instance` for `source_instance_id` and `statutory_instance_id`), `iso_action` (exactly one of five
  subject columns), `management_review`, `review_input` and `review_output` (one live row per review and definition, archived
  rows beside it; migration 0043). `review_input` stores a held review's figures once: all three figure columns or
  none, the figures a JSON object, then a trigger refuses any change to them, the definition, the review or the archive
  (`notes` stays editable).
- `nonconformity.number` counts per client from 1: a trigger sets it on insert under a transaction lock on the client
  and keeps it on update; a unique key backs it. Callers never pass it.
- Lists of people and ISO records are join rows, archived when removed, with a partial key on live rows:
  `objective_risk_item`, `internal_audit_unit`, `internal_audit_person` (role AUDITOR, AUDITEE or REPORTED_TO),
  `nonconformity_person` (investigators), `nonconformity_risk_item` (role RELATED or UPDATED), `nonconformity_document`,
  `management_review_person` (attendees). A record's repository reads and writes them as the contract's id lists, and
  checks the result against the contract with its lists in.
- Repositories (`repositories/iso-records.ts`, helpers in `iso-shared.ts`): `riskItems`, `riskControls`, `objectives`,
  `objectiveReadings`, `auditProgrammes`, `internalAudits`, `auditChecklistItems`, `auditFindings`, `nonconformities`,
  `isoActions`, `managementReviews`, `reviewInputs` and `reviewOutputs` (`addForReview` adds one row per key of the
  given standards). Lists take a `UnitScope`; a child record takes its parent's scope, so by-parent reads take none.

Field-level definitions are in `docs/contracts/domain-model.md` (M0); that file wins if it and this list differ.

## Rules

1. **Every client-data table has `firm_id uuid not null`** and an RLS policy `firm_id = current_setting('app.firm_id')::uuid`. Client-scoped tables also carry `client_id` and a policy for client roles. The app connects as a role without `BYPASSRLS`.
2. **Tenant context per transaction**: `withTenant(ctx, fn)` sets `app.firm_id`, `app.client_ids`, `app.person_id` with `SET LOCAL`. Never query outside it in request code.
3. **Isolation test for every new table**: seed two firms, assert firm B sees zero rows of firm A through the app role.
4. **IDs** are UUIDv7. Keep source identifiers (`external_ref`) as data, never as keys.
5. **Dates**: `due_date`, `completed_on`, `period_*` are `date`. Event times are `timestamptz` in UTC.
6. **No hard deletes** of instances, evidence or audit rows. Use `archived_at`. `audit_event` has no UPDATE/DELETE grant.
   The DELETE grants are `import_issue` (working data regenerated by each analysis; `importIssues.removeGroups`) and
   `idempotency_key` (expired rows only, by a restrictive policy; `idempotencyKeys.purgeExpired` for M9).
   The one exception for a whole account is `platform_purge_account` (ADR M15-0002): owned by `canopy_purge`, it runs
   only for a firm `PENDING_DELETION` for 30 days, marks it `DELETED`, and deletes its rows in every firm table from a
   fixed list, `audit_event` included. The audit trigger lets a DELETE through only when `current_user` is
   `canopy_purge` and the row's firm is `DELETED`; UPDATE and TRUNCATE are always refused. Only `canopy_operator`
   has EXECUTE on it, and `createDatabase` refuses a login that is, or can `SET ROLE` to, `canopy_purge`. Every new
   table with `firm_id` must join that list, or the kept list of ADR M15-0002 decision 4, in the same migration (a
   schema test checks both).
7. **Derived status is not stored** as the source of truth; the engine derives it. A materialised `status_cache` column is allowed for list performance if a job refreshes it daily and on every transition, and tests prove it matches the engine. One exception, which is a record and not a cache: a held review's figures (`review_input.source_figures`, `figures_stored_at`, `figures_engine_version`; model §1.7, §3.13) are stored once at RECORD_HELD and a trigger keeps them unchanged (migration 0043).
8. **Migrations**: Drizzle Kit generated, reviewed by hand, forward-only. Each migration is safe on a populated table (add nullable, backfill, then constrain). Never edit an applied migration.
9. **Indexes** at least on `(firm_id, client_id, due_date)`, `(assignment_id, period_start)`, `(owner_id, workflow_state)`, `(approver_id, workflow_state)`.
10. **Seeds**: `pnpm db:seed` creates two firms and loads the sample register through the importer, not with hand-written inserts.

## How it is built (M3)

Decisions and their reasons: `docs/adr/0003-m3-tenant-isolation-in-postgres.md`.

- Schema: `src/schema/*.ts` (Drizzle). Enums come from `@canopy/contracts`. Policies use the helpers in `src/schema/columns.ts`.
- Migrations: `migrations/`, applied by `pnpm db:migrate`. `pnpm --filter @canopy/db db:generate` writes the schema diff;
  roles, functions, `FORCE ROW LEVEL SECURITY`, grants and triggers go in custom migrations
  (`pnpm --filter @canopy/db exec drizzle-kit generate --custom --name=<what>`).
- Access: `createDatabase({ connectionString }).withTenant(ctx, async (tx) => ...)`. Build `ctx` with `tenantFromRequest(requestContext)`
  in the API and `systemContext(firmId, requestId)` in jobs and imports. `createAdminDatabase` (migrate, createFirm) is for deploy, seed and tests only.
- Deploy: migrations run as the owner, which need not be a superuser; the one-time grants it needs are in the ADR's
  Consequences. Pre-tenant lookups are `SECURITY DEFINER` functions owned by `canopy_lookup`, never by the owner.
- Production login: a non-owner member of `canopy_app`. With `NODE_ENV=production`, `createDatabase` refuses a login that is, or can `SET ROLE` to, a superuser, BYPASSRLS, table-owning, `canopy_lookup`, `canopy_platform`, `canopy_jobs`, `canopy_purge` or `canopy_operator` role. A non-superuser owner must be able to `SET ROLE` to `canopy_lookup`, `canopy_platform`, `canopy_jobs` and `canopy_purge` (migrations hand each its functions).
- Job queue (ADR M3-0004): the `pgboss` schema belongs to `canopy_jobs`, never `canopy_app`. pg-boss uses its own login, a member
  of `canopy_jobs` only, that starts as `canopy_jobs` (`ALTER ROLE <login> SET role = canopy_jobs`); no tenant role gets USAGE on it.
- Operator console (M15, ADR M3-0002): `createOperatorDatabase({ connectionString })` with its own login, a member of
  `canopy_operator` only (refused if it can become `canopy_app`). `withOperator(requestId, (tx) => ...)` runs as `canopy_operator` with no tenant;
  repositories `platformAccounts` and `platformSupport` take that `OperatorTx`. Every write inside a tenant is a
  `platform_*` function owned by `canopy_platform`, with no exception: the master library copy runs app-side from
  `account.created`. The app side reads its own account with `account.get` / `account.usage` (`account.features` and
  `account.isoCatalogueCopiedAt` for the ISO add-on; M6's ISO copy marks with `accountJobs.markIsoCatalogueCopied`) and
  manages `supportGrants`.
- Repositories (`src/repositories`, exported from `@canopy/db`): one object per aggregate (`clients`, `units`, `people`,
  `memberships`, `obligations`, `assignments`, `instances`, `evidence`, `comments`, `auditEvents`, `importBatches`,
  `domainEvents`, ...). Every function takes the `TenantTx` from `withTenant` first:
  `db.withTenant(ctx, (tx) => clients.list(tx, { limit: 50 }))`. Reads and writes return the M0 contract types, parsed
  by the contract schemas. The usual set is `get` (null), `require` (NOT_FOUND), `list` (keyset `{ items, nextCursor }`),
  `create`, `update(tx, id, version, patch)` (optimistic, STALE_VERSION), `archive` and `restore`; there is no delete.
  Errors are `DbError` with `code` NOT_FOUND, DUPLICATE, VALIDATION, FORBIDDEN or STALE_VERSION.
- Most aggregates also have `query(tx, { where, search, includeArchived, orderBy, after, limit, count })` (where is
  equality or an array per contract field; keyset on `orderBy` then id, `after` = last row's value and id) and
  `findAll(tx, where)`. Any contract field of the entity is accepted, so callers pass a fixed allow-list of filter and
  search fields, never field names from the request. M6 lookups: `people.idsInClient`, `people.firmStaffIds`, `assignments.obligationIds`,
  `instances.reassignOpen` and `instances.replacePerson` (return the changed rows with before values).
- Scheduled jobs (M9): `db.listFirmIds()` returns firm ids only (a SECURITY DEFINER function that any app-role
  transaction could call; only jobs use it);
  each firm then runs in `withTenant(systemContext(firmId, ...))` with the `jobs` read models and
  `notificationSends` (`claim` returns NEW, PENDING or DONE; `listDone` lists instance and digest sends, `listDoneIso`
  ISO reminders with their subject).
  `db.listFirmIdsWithFeature(flag)` (migration 0042) returns only the TRIAL and ACTIVE firms whose effective features
  include `flag`, also ids only, from a function owned by `canopy_lookup` with column grants on what it reads.
- Act kinds (ISO-2f, docs/iso/plan.md §4.6): the register, the evidence vault, `jobs.listScoreItems` and the act,
  obligation and assignment lists take `actKinds` (`['STATUTE']` for statutory numbers; absent reads both, an empty
  list matches nothing). `actKindOf.instance|obligation|assignment` gives the kind behind one row, or null when it is
  not visible, for the add-on's off-switch checks; `actKindOf.instances(tx, ids)` answers many instances in one read
  per 1,000 ids (a `Map`, unseen ids left out; ISO-2j).
- ISO file scans (ISO-2j): `isoFiles.settleScan(tx, id, status)` writes a result only on a live PENDING file (in the
  UPDATE's WHERE) and returns whether it wrote, so a remove that commits first is not overwritten.
- ISO lists by id (ISO-2i): the nonconformity, risk, objective and document filters take `ids` (1 to 200, each once),
  AND'd with the other filters and the unit scope before keyset paging; with `ids` the document list drops its
  ACTIVE-only default; internal audits take `ids` too (ISO-2j). The document list's `q` matches code, title, issuer and
  external reference. ISO-2j adds `standards` (any of) on nonconformities, and on actions `managementSystemIds` (the
  subject's system; a finding's through its audit), `subjectId`, `q` on the text and `dueFrom`.
- Role lookup (ISO-2i, model §1 rule 5): `memberships.holdsRole(tx, { personId, roles, clientId, unitId? })` says
  whether a live person (not archived or DISABLED; migration 0045) holds a live role in a client covering the unit,
  including memberships the context cannot read (a firm admin's or consultant's, for a client role). It calls `canopy_person_holds_role` (migration 0044), owned by
  `canopy_lookup` with a firm-limited `role_lookup` policy on `membership` and column grants; false for a client the
  context may not see.
- In a single-table select, Drizzle leaves columns unqualified, so a correlated subquery inside `sql` binds them to
  the inner table. Use a join or two queries instead.
- Imports (M8): `importBatches.create` takes an optional `id` (a UUIDv7 from `uuidv7()`, exported here) so an upload
  ticket can name the batch first; `importBatches.list` is newest first (`list` takes `order: 'asc' | 'desc'`).
- Reads for M10 and M5: `instances.register` takes `unitIds`, `departmentIds`, `actIds`, `categoryIds` and `domain` lists;
  `instances.exportDetails`, `auditEvents.latestByClient`, `units.withLabels`, `units.count`, `clients.generatedRange`.
  `people.reach` (M6) returns a person's client ids and firm-staff flag through `app_person_reach` (ids only).
- Sign-in (M5, ADR M3-0001): `db.findLoginCandidates`, `db.findSession` and `db.findLoginToken` are the pre-tenant
  lookups and return nothing inside a `withTenant` transaction; `credentials`, `sessions`, `loginTokens` and `invites` run in
  `withTenant`. Tokens are stored as SHA-256 hex only. `sessions.create` takes an optional `createdAt` (the
  caller's clock, which its `expiresAt` comes from); without it the database clock is the created time. `invites.openForPerson(tx, personId, now)` lists a
  person's open invites (M5's invitee check).
- Idempotency (M7): `idempotencyKeys.find(tx, personId, key)` ignores expired rows; `record` writes in the caller's
  transaction, replaces an expired row and raises DUPLICATE on an unexpired one, also from a concurrent request.
- Workflow (M7): `auditEvents.query` and `evidence.vault` page newest first with a keyset `nextCursor` (the last row's id;
  its time is read back from the table, so microseconds survive). Their time bounds are UTC instants, half-open
  `[from, to)`: the caller turns a client-zone date into instants with the engine helpers (root rule 4).
  `withSavepoint(tx, fn)` runs `fn` in a savepoint that keeps the tenant context and rolls back alone on error.
- Repositories never write audit or outbox rows themselves. The caller (M7 workflow, M8 import) calls
  `auditEvents.append(tx, ...)` and `domainEvents.enqueue(tx, ...)` in the same `withTenant` transaction as the change.
- Client contexts create people with `people.createWithMembership` (the new person is invisible until a membership
  exists) and change people one row at a time by id.
- Never build SQL outside this package (no `sql.raw` in request code): the tenant settings are plain GUCs that raw SQL could change.
- Tests: `pnpm test` (unit, includes a drift check that the migrations match the schema) and `pnpm test:db` (needs Postgres 16 at
  `DATABASE_URL`; each file creates and drops its own database). Adding a table: see the ADR's Consequences.
