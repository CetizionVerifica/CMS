-- Tenancy plumbing used by every table's defaults and RLS policies (packages/db/CLAUDE.md rules 1, 2, 4).
-- Custom migration: Drizzle Kit does not model roles' grants or SQL functions.

-- The role every request transaction runs as (`withTenant` does SET LOCAL ROLE). It never bypasses RLS.
-- The connecting user must be a member so it can switch to it; the grant below covers the migrating user.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'canopy_app') THEN
    CREATE ROLE canopy_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
--> statement-breakpoint
GRANT canopy_app TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO canopy_app;
--> statement-breakpoint

-- UUIDv7 (RFC 9562): 48-bit Unix milliseconds, version 7, random rest. Postgres 16 has no built-in.
CREATE FUNCTION canopy_uuid_v7() RETURNS uuid
LANGUAGE sql VOLATILE PARALLEL SAFE
AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(uuid_send(gen_random_uuid())
          PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
          FROM 1 FOR 6),
        52, 1),
      53, 1),
    'hex')::uuid
$$;
--> statement-breakpoint

-- Tenant of the current transaction, set by withTenant. Null when unset, so policies match nothing.
CREATE FUNCTION app_firm_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT nullif(current_setting('app.firm_id', true), '')::uuid $$;
--> statement-breakpoint

-- Person acting in the current transaction, or null for system and import work.
CREATE FUNCTION app_person_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT nullif(current_setting('app.person_id', true), '')::uuid $$;
--> statement-breakpoint

-- Clients the transaction may see; empty when unset.
CREATE FUNCTION app_client_ids() RETURNS uuid[]
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT coalesce(nullif(current_setting('app.client_ids', true), '')::uuid[], '{}'::uuid[]) $$;
--> statement-breakpoint

-- True for firm-wide contexts (firm admins, system jobs): every client of the firm.
CREATE FUNCTION app_all_clients() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT coalesce(current_setting('app.all_clients', true) = 'on', false) $$;
--> statement-breakpoint

-- Whether the transaction may see a client's rows. A null client is visible to firm-wide contexts only.
CREATE FUNCTION app_can_see_client(target uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT app_all_clients() OR coalesce(target = ANY (app_client_ids()), false) $$;
--> statement-breakpoint

-- Keeps updated_at current on every UPDATE.
CREATE FUNCTION canopy_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- Audit rows are append-only for every role, the owner included (packages/db/CLAUDE.md rule 6).
CREATE FUNCTION canopy_reject_audit_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
