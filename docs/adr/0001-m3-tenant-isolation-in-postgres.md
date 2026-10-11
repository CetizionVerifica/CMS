# ADR 0001: Tenant isolation in Postgres (M3)

Status: accepted · 2026-10-11 · Module M3 (`packages/db`)

## Context
Root `CLAUDE.md` non-negotiable 1 and `packages/db/CLAUDE.md` rules 1-3 require `firm_id` and an RLS policy on every
client-data table, a request-scoped tenant context, and an app role without `BYPASSRLS`. Client roles must also be kept
to their own client. The details below were not fixed by the spec.

## Decisions
1. **App role by `SET LOCAL ROLE`.** Migration 0000 creates `canopy_app` (NOLOGIN, no BYPASSRLS). `withTenant` opens a
   transaction, switches to `canopy_app` and sets `app.firm_id`, `app.person_id`, `app.client_ids`, `app.all_clients`
   and `app.request_id` with `set_config(..., true)`. RLS therefore holds even when the connecting user is a superuser
   (local dev and CI). In production the connecting user should be a non-owner member of `canopy_app`.
2. **Policies bind owners too.** Every table has `FORCE ROW LEVEL SECURITY` and one `tenant_isolation` policy for all
   roles. Unset settings make `app_firm_id()` null, so a missing context sees and writes nothing.
3. **Client scope in RLS, unit scope in `can()`.** Client-scoped tables check `app_can_see_client(client_id)`: true when
   the context is firm-wide (`clientIds: 'ALL'`, for firm admins and system jobs) or the client is in the list.
   `tenantFromRequest` maps a FIRM_ADMIN to `'ALL'` so a client created in the request is writable. Owner/approver unit
   limits stay in the M5 policy.
4. **Null client rows.** `membership`, `mapping_template`, `audit_event` and `domain_event` allow a null `client_id`.
   Such rows are visible only to firm-wide contexts, except that a person always sees their own memberships (M5 builds
   the request context from them). Client contexts may insert null-client audit and outbox rows (a login, say) but
   cannot read them back, so those inserts must not use `RETURNING`.
5. **Composite foreign keys.** Children reference parents on `(firm_id, id)` and, inside a client, on
   `(firm_id, client_id, id)`. Foreign key checks bypass RLS, so without this a row in firm B could point at a known id
   in firm A; it also keeps an instance's denormalised `client_id` and `unit_id` equal to its assignment's.
6. **No deletes.** The app role gets SELECT, INSERT and UPDATE only (`firm`: SELECT, UPDATE; `audit_event`: SELECT,
   INSERT). A trigger rejects UPDATE, DELETE and TRUNCATE on `audit_event` for every role. Firms are created by
   `createAdminDatabase().createFirm` on the owner connection.
7. **Ids and names.** UUIDv7 come from `canopy_uuid_v7()` (Postgres 16 has none built in). Name uniqueness is exact
   and among non-archived rows (Acts, categories per firm; companies, departments per client; units per company), so
   the importer's `raw` profile can hold spellings that differ only by case. `person.name_normalized` is indexed, not
   unique: two people may share a name.
8. **Contract invariants as CHECK constraints.** README decisions 9-12 and 14 (jurisdiction/state code, person email
   by status, membership shape by role, instance consistency, issue severity by type) are also database constraints.
   They are shape rules, not status or due-date maths, which stays in `packages/engine`.

## Consequences
- A new table needs, in its migration: `firm_id` with the composite keys above, a policy (schema helpers in
  `src/schema/columns.ts`), `FORCE ROW LEVEL SECURITY`, grants without DELETE, an `updated_at` trigger if it has the
  column, and rows in `test/support/populate.ts`. `test/schema-rules.db.test.ts` and `test/isolation.db.test.ts` fail
  until all of these are there.
- Cross-firm jobs (nightly generation) need a way to list firms; that is added with the job, as a narrow
  `SECURITY DEFINER` function, not by giving the app role BYPASSRLS.
