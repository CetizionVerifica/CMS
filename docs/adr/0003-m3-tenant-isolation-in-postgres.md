# ADR 0003: Tenant isolation in Postgres (M3)

Status: accepted · 2026-10-11 · Module M3 (`packages/db`)

## Context
Root `CLAUDE.md` non-negotiable 1 and `packages/db/CLAUDE.md` rules 1-3 require `firm_id` and an RLS policy on every
client-data table, a request-scoped tenant context, and an app role without `BYPASSRLS`. Client roles must also be kept
to their own client. The details below were not fixed by the spec.

## Decisions
1. **App role by `SET LOCAL ROLE`.** Migration 0000 creates `canopy_app` (NOLOGIN, no BYPASSRLS). `withTenant` opens a
   transaction, switches to `canopy_app` and sets `app.firm_id`, `app.person_id`, `app.client_ids`, `app.all_clients`
   and `app.request_id` with `set_config(..., true)`. RLS therefore holds even when the connecting user is a superuser
   (local dev and CI). In production the connecting user must be a non-owner member of `canopy_app`:
   `createDatabase` refuses a login that is, or is a member of, a superuser, a BYPASSRLS role or a role owning tables
   in `public` when `NODE_ENV=production` (option `privilegedLogin`), because such a login could `RESET ROLE` or
   `SET ROLE` out of RLS inside `withTenant`. A plain member stays inside RLS even after `RESET ROLE` (`test/login.db.test.ts`).
2. **Policies bind owners too.** Every table has `FORCE ROW LEVEL SECURITY` and one `tenant_isolation` policy for all
   roles. Unset settings make `app_firm_id()` null, so a missing context sees and writes nothing.
3. **Client scope in RLS, unit scope in `can()`.** Client-scoped tables check `app_can_see_client(client_id)`: true when
   the context is firm-wide (`clientIds: 'ALL'`, for firm admins and system jobs) or the client is in the list.
   `tenantFromRequest` maps a FIRM_ADMIN to `'ALL'` so a client created in the request is writable. Owner/approver unit
   limits stay in the M5 policy.
   Firm-wide rows (`firm`, `act`, `category`, `obligation`, `location`) are readable by every context of the firm, but
   only **firm staff** contexts change them (`app.firm_staff`: firm admins, consultants and system jobs;
   `tenantFromRequest` sets it from the memberships). Client contexts may add a location. **People**: firm staff see
   everyone; a client context sees itself and the people of its clients (a membership, assignment or instance there),
   and cannot update anyone holding a firm role (`app_person_has_firm_role`) or working for a client it cannot see
   (`app_person_in_hidden_client`, e.g. one person the importer de-duplicated across two clients). Both are yes/no
   SECURITY DEFINER functions with a fixed `search_path`, filtered to the context's firm.
   A client admin creating a person inserts it without `RETURNING`, then the membership, after which it is visible.
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

## Limits other modules must know (audit of PR #16)
- The tenant settings are ordinary GUCs: SQL running inside `withTenant` could call `set_config('app.firm_id', ...)`
  and switch tenants. Request code must not build SQL itself: queries go through `packages/db` repositories, and
  `sql.raw` stays inside `packages/db`. A lint rule banning `sql.raw` elsewhere is proposed for M1's ESLint config.
- RLS has no notion of roles. Inside one client it does not stop an OWNER changing memberships, including their own
  role; that rests on M5 `can()`, so M5 and M6 tests must cover membership writes for every role.
- Consultants are firm staff: they see every person of the firm and may change firm settings and the library,
  although their client list is limited. M5/M6 `can()` keeps those writes to what `endpoints.md` allows.
- One person can belong to several clients. M8's person de-dupe by `name_normalized` merges across clients only on
  purpose; a client context can then no longer edit that person (above).
- A client context's person update runs three plpgsql checks per row (`app_person_visible`,
  `app_person_has_firm_role`, `app_person_in_hidden_client`). Repositories keep client-context person writes to one
  row by id (`people.update`); M6 must not add bulk person updates for client contexts.
- The populated-database migration test fills data after the last migration that exists. The first migration that
  changes an existing table must add a populate step for the state before it (`test/migrations.db.test.ts`).

## Consequences
- A new table needs, in its migration: `firm_id` with the composite keys above, a policy (schema helpers in
  `src/schema/columns.ts`), `FORCE ROW LEVEL SECURITY`, grants without DELETE, an `updated_at` trigger if it has the
  column, and rows in `test/support/populate.ts`. `test/schema-rules.db.test.ts` and `test/isolation.db.test.ts` fail
  until all of these are there.
- Cross-firm jobs (nightly generation) need a way to list firms; that is added with the job, as a narrow
  `SECURITY DEFINER` function, not by giving the app role BYPASSRLS.
