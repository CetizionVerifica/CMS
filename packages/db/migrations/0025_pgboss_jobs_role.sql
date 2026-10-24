-- The pgboss schema moves from canopy_app (0022) to canopy_jobs (audit of #153, Medium 1; ADR M3-0004). pg-boss's
-- job rows carry every firm's ids and have no RLS, so a tenant transaction (SET LOCAL ROLE canopy_app) must not reach
-- them. canopy_jobs has no membership in or from canopy_app; pg-boss's own login starts its sessions as canopy_jobs.
DO $$
BEGIN
  CREATE ROLE canopy_jobs NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
EXCEPTION WHEN OTHERS THEN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'canopy_jobs') THEN
    RAISE;
  END IF;
END
$$;
--> statement-breakpoint
-- The schema is taken over only while it is empty (Low 2): tables pg-boss already made belong to whoever ran it, and
-- moving the schema alone would leave them open to that owner.
DO $$
DECLARE
  v_owner text;
BEGIN
  SELECT pg_get_userbyid(nspowner) INTO v_owner FROM pg_namespace WHERE nspname = 'pgboss';
  IF v_owner IS NULL THEN
    CREATE SCHEMA pgboss AUTHORIZATION canopy_jobs;
  ELSIF v_owner <> 'canopy_jobs' THEN
    IF EXISTS (SELECT FROM pg_depend d JOIN pg_namespace n ON n.oid = d.refobjid
               WHERE d.refclassid = 'pg_namespace'::regclass AND n.nspname = 'pgboss') THEN
      RAISE EXCEPTION 'schema pgboss is not canopy_jobs''s and already holds objects: drop it (pg-boss recreates its tables; queued jobs are lost) or give it and its objects to canopy_jobs, then migrate again'
        USING ERRCODE = 'object_in_use';
    END IF;
    ALTER SCHEMA pgboss OWNER TO canopy_jobs;
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON SCHEMA pgboss FROM PUBLIC, canopy_app;
