-- The one cross-tenant read: scheduled jobs (M9) list the firms they serve, then do each firm's work in its
-- own tenant transaction (ADR 0003, Consequences). Ids only, so the app role never needs BYPASSRLS.
-- Custom migration: Drizzle Kit does not model roles, SQL functions or function owners.

-- FORCE RLS binds the table owner, so a SECURITY DEFINER function owned by the migrating user would see no
-- firm unless that user is a superuser. The lookups run as canopy_lookup instead: no login, no BYPASSRLS,
-- column grants on the ids it returns, and `lookup_read` policies (schema) that apply to it alone.
-- canopy_app is not a member, so request code cannot SET ROLE to it.
DO $$
BEGIN
  CREATE ROLE canopy_lookup NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
EXCEPTION WHEN OTHERS THEN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'canopy_lookup') THEN
    RAISE;
  END IF;
END
$$;
--> statement-breakpoint
-- ALTER FUNCTION ... OWNER TO needs the migrating user to be able to SET ROLE canopy_lookup.
DO $$
BEGIN
  IF NOT pg_has_role(current_user, 'canopy_lookup', 'SET') THEN
    GRANT canopy_lookup TO CURRENT_USER;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF NOT pg_has_role(current_user, 'canopy_lookup', 'SET') THEN
    RAISE;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO canopy_lookup;
--> statement-breakpoint
GRANT SELECT ("id") ON "firm" TO canopy_lookup;
--> statement-breakpoint
CREATE FUNCTION canopy_list_firm_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT id FROM firm ORDER BY id $$;
--> statement-breakpoint
-- A new owner needs CREATE on the schema at the moment of the change only.
GRANT CREATE ON SCHEMA public TO canopy_lookup;
--> statement-breakpoint
ALTER FUNCTION canopy_list_firm_ids() OWNER TO canopy_lookup;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM canopy_lookup;
--> statement-breakpoint
REVOKE ALL ON FUNCTION canopy_list_firm_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION canopy_list_firm_ids() TO canopy_app;
