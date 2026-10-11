# packages/db: schema, tenancy, migrations

PostgreSQL 16 with Drizzle ORM. Root `CLAUDE.md` applies.

## Tables (v1)
Tenancy and people
- `firm` (consultancy tenant), `client` (org group, e.g. "Aditya Birla Group"), `company` ("Hindalco"), `unit` ("Plant", with `location_id`)
- `location` (country, state, city; state drives state-law applicability, e.g. West Bengal)
- `person` (name, email, `name_normalized` for dedupe, `status` e.g. unclaimed/active/disabled), `membership` (person × firm or client, role, `consultant_client_ids`, `unit_ids`, `expires_at`), `department` (per client, with `aliases text[]`)

Library
- `act` (name, short name, jurisdiction `CENTRAL | STATE`, state code, `aliases text[]`)
- `obligation` (`external_ref` e.g. "TAX-CL-033-6067-60218", `domain`, `jurisdiction`, title, description, `category_id`, `criticality`, `timeline_type`, `recurrence_rule jsonb` validated by the engine schema, `applicability_text`, `forms jsonb`, `log_sheets jsonb`, `evidence_required`, `rule_status`, `library_version`)
- `category` (name, `aliases text[]`)

Work
- `assignment` (obligation × unit × department, `default_owner_id`, `default_approver_id`, `applicability` `APPLICABLE | NOT_APPLICABLE | TO_ASSESS`, `na_reason`, active from/to)
- `compliance_instance` (`assignment_id`, `period_start`, `period_end`, `due_date date`, `workflow_state`, `pending_kind`, `completed_on date`, `na_reason`, `due_date_overridden`, `version`, `owner_id`, `approver_id`, `submitted_at`, `approved_at`, unique `(assignment_id, period_start)`)
- `evidence` (instance, storage key, file name, size, mime, sha256, scan status, uploaded by), `comment` (instance, author, body)
- `audit_event` (append-only: actor, action, entity, entity id, before jsonb, after jsonb, at, request id)
- `import_batch`, `import_row` (raw row jsonb, mapped jsonb, outcome), `import_issue` (per row/field issue and resolution) and `mapping_template` (saved column mappings per client) for traceable imports
- `domain_event` (transactional outbox for the event catalogue), `export_job` (Excel/PDF exports), `notification_send` (send log, unique per instance, kind, send date)

Field-level definitions are in `docs/contracts/domain-model.md` (M0); that file wins if it and this list differ.

## Rules
1. **Every client-data table has `firm_id uuid not null`** and an RLS policy `firm_id = current_setting('app.firm_id')::uuid`. Client-scoped tables also carry `client_id` and a policy for client roles. The app connects as a role without `BYPASSRLS`.
2. **Tenant context per transaction**: `withTenant(ctx, fn)` sets `app.firm_id`, `app.client_ids`, `app.person_id` with `SET LOCAL`. Never query outside it in request code.
3. **Isolation test for every new table**: seed two firms, assert firm B sees zero rows of firm A through the app role.
4. **IDs** are UUIDv7. Keep source identifiers (`external_ref`) as data, never as keys.
5. **Dates**: `due_date`, `completed_on`, `period_*` are `date`. Event times are `timestamptz` in UTC.
6. **No hard deletes** of instances, evidence or audit rows. Use `archived_at`. `audit_event` has no UPDATE/DELETE grant.
7. **Derived status is not stored** as the source of truth; the engine derives it. A materialised `status_cache` column is allowed for list performance if a job refreshes it daily and on every transition, and tests prove it matches the engine.
8. **Migrations**: Drizzle Kit generated, reviewed by hand, forward-only. Each migration is safe on a populated table (add nullable, backfill, then constrain). Never edit an applied migration.
9. **Indexes** at least on `(firm_id, client_id, due_date)`, `(assignment_id, period_start)`, `(owner_id, workflow_state)`, `(approver_id, workflow_state)`.
10. **Seeds**: `pnpm db:seed` creates two firms and loads the sample register through the importer, not with hand-written inserts.

## How it is built (M3)
Decisions and their reasons: `docs/adr/0001-m3-tenant-isolation-in-postgres.md`.
- Schema: `src/schema/*.ts` (Drizzle). Enums come from `@canopy/contracts`. Policies use the helpers in `src/schema/columns.ts`.
- Migrations: `migrations/`, applied by `pnpm db:migrate`. `pnpm --filter @canopy/db db:generate` writes the schema diff;
  roles, functions, `FORCE ROW LEVEL SECURITY`, grants and triggers go in custom migrations
  (`pnpm --filter @canopy/db exec drizzle-kit generate --custom --name=<what>`).
- Access: `createDatabase({ connectionString }).withTenant(ctx, async (tx) => ...)`. Build `ctx` with `tenantFromRequest(requestContext)`
  in the API and `systemContext(firmId, requestId)` in jobs and imports. `createAdminDatabase` (migrate, createFirm) is for deploy, seed and tests only.
- Tests: `pnpm test` (unit, includes a drift check that the migrations match the schema) and `pnpm test:db` (needs Postgres 16 at
  `DATABASE_URL`; each file creates and drops its own database). Adding a table: see the ADR's Consequences.
