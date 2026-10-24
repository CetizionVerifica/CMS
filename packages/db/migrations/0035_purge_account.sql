-- Purging a deleted account at the end of its 30-day grace period (ADR M15-0002): the one sanctioned exception to
-- "never delete audit rows" and "no hard deletes" (root CLAUDE.md non-negotiable 2, packages/db/CLAUDE.md rule 6).
-- Custom migration: Drizzle Kit does not model roles, functions, triggers, policies or grants.
--
-- platform_purge_account(firm) runs as canopy_purge: no login, no BYPASSRLS, not a member of any request role. Only
-- the migrating user is a member, to hand it the functions (as with canopy_lookup), and createDatabase refuses a
-- request or console login that can become it. EXECUTE goes to canopy_operator alone. The function takes no table
-- name or filter: the tables come from canopy_purge_tables(), a fixed list in this migration that a schema test
-- compares with every public table holding firm_id, so a later table cannot be left behind.

-- 1. The role.
DO $$
BEGIN
  CREATE ROLE canopy_purge NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
EXCEPTION WHEN OTHERS THEN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'canopy_purge') THEN
    RAISE;
  END IF;
END
$$;
--> statement-breakpoint
-- ALTER FUNCTION ... OWNER TO needs the migrating user to be able to SET ROLE canopy_purge.
DO $$
BEGIN
  IF NOT pg_has_role(current_user, 'canopy_purge', 'SET') THEN
    GRANT canopy_purge TO CURRENT_USER;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF NOT pg_has_role(current_user, 'canopy_purge', 'SET') THEN
    RAISE;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public, platform TO canopy_purge;--> statement-breakpoint

-- 2. The tables, children before parents (foreign-key order). Kept: firm (the tombstone) and the platform schema
--    (subscriptions, usage, overrides for invoicing history; the operator trail is never deleted).
CREATE FUNCTION canopy_purge_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT ARRAY[
    'auth_token', 'auth_session', 'auth_credential', 'idempotency_key', 'notification_send',
    'import_issue', 'import_row', 'import_batch', 'mapping_template', 'export_job',
    'evidence', 'comment', 'compliance_instance', 'assignment', 'obligation', 'act', 'category',
    'unit', 'company', 'location', 'department', 'auth_invite', 'support_grant', 'membership',
    'audit_event', 'domain_event', 'person', 'client'
  ]::text[]
$$;
--> statement-breakpoint

-- 3. What canopy_purge may touch: DELETE and SELECT (firm_id) on each listed table, through policies that apply to
--    it alone and only to the firm in app.firm_id, which the function sets.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY canopy_purge_tables() LOOP
    EXECUTE format('GRANT SELECT ("firm_id"), DELETE ON %I TO canopy_purge', t);
    EXECUTE format('CREATE POLICY purge_read ON %I FOR SELECT TO canopy_purge USING (firm_id = app_firm_id())', t);
    EXECUTE format('CREATE POLICY purge_delete ON %I FOR DELETE TO canopy_purge USING (firm_id = app_firm_id())', t);
  END LOOP;
END
$$;
--> statement-breakpoint
GRANT SELECT ("id", "status", "deletion_requested_at"), UPDATE ("status", "settings", "profile") ON "firm" TO canopy_purge;--> statement-breakpoint
CREATE POLICY purge_update ON "firm" FOR UPDATE TO canopy_purge USING (id = app_firm_id()) WITH CHECK (id = app_firm_id());--> statement-breakpoint
GRANT INSERT ON "platform"."operator_audit_event" TO canopy_purge;--> statement-breakpoint

-- Two restrictive DELETE policies apply to every role. They keep their rule for everyone but canopy_purge, which
-- removes the firm's rows whatever their state. The import_issue one reads import_batch, which Postgres checks
-- whichever side of the OR decides, so canopy_purge reads those two columns as well.
GRANT SELECT ("id", "status") ON "import_batch" TO canopy_purge;--> statement-breakpoint
ALTER POLICY delete_expired ON "idempotency_key"
  USING (current_user = 'canopy_purge' OR ((firm_id = app_firm_id()) AND (expires_at < now())));--> statement-breakpoint
ALTER POLICY delete_before_commit ON "import_issue"
  USING (current_user = 'canopy_purge' OR ((firm_id = app_firm_id()) AND (EXISTS (SELECT 1 FROM import_batch b
    WHERE b.id = import_issue.batch_id
      AND b.status = ANY (ARRAY['UPLOADED', 'MAPPED', 'PARSED', 'REVIEWED', 'DRY_RUN_READY']::import_batch_status[])))));--> statement-breakpoint

-- 4. The append-only trail allows one thing: canopy_purge deleting a row of a firm that is already DELETED. UPDATE and
--    TRUNCATE are refused for everyone, as before. There is no flag or setting to turn this on: current_user is
--    canopy_purge only inside its own definer function, and a firm becomes DELETED only through that function.
CREATE OR REPLACE FUNCTION canopy_reject_audit_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'canopy_purge'
     AND EXISTS (SELECT 1 FROM firm f WHERE f.id = OLD.firm_id AND f.status = 'DELETED') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_event is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint

-- 5. Only the purge makes a firm DELETED, and only from PENDING_DELETION past its 30 days; a DELETED firm stays so.
CREATE FUNCTION canopy_firm_deleted_by_purge() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'DELETED' THEN
    IF NEW.status <> 'DELETED' THEN
      RAISE EXCEPTION 'a deleted account cannot change status' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'DELETED' AND (
       TG_OP = 'INSERT' OR current_user <> 'canopy_purge' OR OLD.status <> 'PENDING_DELETION'
       OR OLD.deletion_requested_at IS NULL OR OLD.deletion_requested_at > now() - interval '30 days') THEN
    RAISE EXCEPTION 'only the purge, after the 30-day grace period, deletes an account'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "firm_deleted_by_purge" BEFORE INSERT OR UPDATE OF "status" ON "firm"
  FOR EACH ROW EXECUTE FUNCTION canopy_firm_deleted_by_purge();--> statement-breakpoint

-- 6. The purge. In one transaction: lock the firm; refuse unless it is PENDING_DELETION for 30 days or more; make it
--    DELETED with its settings and profile emptied (the tombstone keeps id, name, kind, plan, dates); delete its rows
--    table by table; record ACCOUNT_PURGE with the row counts (no contents) in the operator trail. Returns the counts,
--    or null for an account already purged, so a retry after a crash does nothing twice.
CREATE FUNCTION platform_purge_account(p_firm uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_request text := coalesce(nullif(current_setting('app.request_id', true), ''), 'account-purge');
  v_status account_status;
  v_requested timestamptz;
  v_counts jsonb := '{}'::jsonb;
  v_rows bigint;
  t text;
BEGIN
  PERFORM set_config('app.firm_id', p_firm::text, true);
  SELECT f.status, f.deletion_requested_at INTO v_status, v_requested FROM firm f WHERE f.id = p_firm FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such account' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_status = 'DELETED' THEN
    RETURN NULL;
  END IF;
  IF v_status <> 'PENDING_DELETION' OR v_requested > now() - interval '30 days' THEN
    RAISE EXCEPTION 'the account is not due for purge' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  UPDATE firm SET status = 'DELETED', settings = '{}'::jsonb, profile = '{}'::jsonb WHERE id = p_firm;
  FOREACH t IN ARRAY canopy_purge_tables() LOOP
    EXECUTE format('DELETE FROM %I WHERE firm_id = $1', t) USING p_firm;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object(t, v_rows);
  END LOOP;
  INSERT INTO platform.operator_audit_event (operator_id, action, account_id, before, after, request_id)
  VALUES (NULL, 'ACCOUNT_PURGE', p_firm, jsonb_build_object('status', 'PENDING_DELETION'),
    jsonb_build_object('status', 'DELETED', 'rows', v_counts), v_request);
  RETURN v_counts;
END
$$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO canopy_purge;--> statement-breakpoint
ALTER FUNCTION platform_purge_account(uuid) OWNER TO canopy_purge;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM canopy_purge;--> statement-breakpoint
REVOKE ALL ON FUNCTION platform_purge_account(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_purge_account(uuid) TO canopy_operator;--> statement-breakpoint
REVOKE ALL ON FUNCTION canopy_purge_tables() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION canopy_purge_tables() TO canopy_purge;
