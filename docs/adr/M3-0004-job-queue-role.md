# ADR M3-0004: The job queue's own role

## Context

pg-boss (ADR M9-0001 decision 1) keeps its job rows in the `pgboss` schema, in the same Postgres as the tenants. Its
tables have no `firm_id` and no RLS, and every firm's events pass through them. Migration 0022 gave the schema
to `canopy_app`, so any tenant transaction could read, cancel or drop another firm's jobs (audit of #153, Medium 1).
Migration 0023 moves it.

## Decisions

1. **`canopy_jobs` owns `pgboss`.** It is a NOLOGIN role with no BYPASSRLS, and no membership in or from `canopy_app`.
   Nothing else has USAGE or CREATE on the schema, so `SET LOCAL ROLE canopy_app` in `withTenant` cannot reach the
   queue.
2. **pg-boss has its own login.** The pg-boss pool connects with a login that is a member of `canopy_jobs` only and
   starts its sessions in that role (`ALTER ROLE <login> SET role = canopy_jobs`), so the tables and queue partitions
   pg-boss creates belong to `canopy_jobs`. pg-boss starts with `createSchema: false`: its `CREATE SCHEMA IF NOT
   EXISTS` needs CREATE on the database even when the schema exists. The tenant login is not used for it: a default role would change what the
   tenant pool runs as outside `withTenant`.
3. **A schema with tables stops the migration.** 0023 takes `pgboss` over from its owner only while it is empty. One
   that already holds pg-boss's tables fails with the steps to fix it, since moving the schema alone would leave those
   tables open to whoever made them.

## Consequences

- Deploy: an administrator creates `canopy_jobs` once (as for `canopy_platform`) and makes the migrating owner a member.
- M9 (`apps/api/src/jobs`) connects pg-boss through a login set up as in decision 2, with `createSchema: false`.
  Checked against pg-boss 12.37: it installs, creates a queue and sends a job that way, and `canopy_app` is refused.
- A local database where pg-boss already made the schema needs `DROP SCHEMA pgboss CASCADE` before migrating.
