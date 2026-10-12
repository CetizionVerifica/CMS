-- The one cross-tenant read: scheduled jobs (M9) list the firms they serve, then do each firm's work in its
-- own tenant transaction (ADR 0003, Consequences). Ids only, so the app role never needs BYPASSRLS.
-- Custom migration: Drizzle Kit does not model SQL functions.
CREATE FUNCTION canopy_list_firm_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT id FROM firm ORDER BY id $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION canopy_list_firm_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION canopy_list_firm_ids() TO canopy_app;
