-- Customer accounts and the platform operator, part 2 (ADR M15-0001 decisions 7, 8, 11, 12; ADR M3-0002): grants,
-- forced RLS, triggers, the canopy_platform role and the SECURITY DEFINER functions that are the only writes the
-- operator makes inside a tenant. Custom migration: Drizzle Kit does not model these.

-- ---------- canopy_app: its own account columns are read-only ----------
-- An account admin may rename the firm and change its settings, never its status, plan or trial.
REVOKE UPDATE ON "firm" FROM canopy_app;--> statement-breakpoint
GRANT UPDATE ("name", "settings", "version") ON "firm" TO canopy_app;--> statement-breakpoint

-- ---------- support_grant: a tenant table ----------
ALTER TABLE "support_grant" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "support_grant" TO canopy_app;--> statement-breakpoint
CREATE TRIGGER "support_grant_touch_updated_at" BEFORE UPDATE ON "support_grant" FOR EACH ROW EXECUTE FUNCTION canopy_touch_updated_at();--> statement-breakpoint

-- ---------- canopy_operator ----------
GRANT USAGE ON SCHEMA platform TO canopy_operator;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "platform"."plan" TO canopy_operator;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "platform"."account_override" TO canopy_operator;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "platform"."subscription" TO canopy_operator;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "platform"."usage_snapshot" TO canopy_operator;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "platform"."operator" TO canopy_operator;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "platform"."operator_credential" TO canopy_operator;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "platform"."operator_session" TO canopy_operator;--> statement-breakpoint
-- Append-only (decision 12).
GRANT SELECT, INSERT ON "platform"."operator_audit_event" TO canopy_operator;--> statement-breakpoint
-- The firm row and nothing else in public, plus the non-personal columns of support grants (operator_read policy).
GRANT USAGE ON SCHEMA public TO canopy_operator;--> statement-breakpoint
GRANT SELECT ON "firm" TO canopy_operator;--> statement-breakpoint
GRANT UPDATE ("name", "status", "plan_code", "trial_ends_on", "onboarded_at", "profile", "deletion_requested_at", "status_before_deletion", "version") ON "firm" TO canopy_operator;--> statement-breakpoint
CREATE POLICY "operator_read" ON "firm" AS PERMISSIVE FOR SELECT TO canopy_operator USING (true);--> statement-breakpoint
-- No firm becomes DELETED this way: only the purge function (ADR M15-0002) may, through its own role.
CREATE POLICY "operator_update" ON "firm" AS PERMISSIVE FOR UPDATE TO canopy_operator USING (status <> 'DELETED') WITH CHECK (status <> 'DELETED');--> statement-breakpoint
GRANT SELECT ("id", "firm_id", "level", "starts_at", "ends_at", "revoked_at") ON "support_grant" TO canopy_operator;--> statement-breakpoint

-- ---------- triggers on the platform tables ----------
CREATE TRIGGER "plan_touch_updated_at" BEFORE UPDATE ON "platform"."plan" FOR EACH ROW EXECUTE FUNCTION canopy_touch_updated_at();--> statement-breakpoint
CREATE TRIGGER "account_override_touch_updated_at" BEFORE UPDATE ON "platform"."account_override" FOR EACH ROW EXECUTE FUNCTION canopy_touch_updated_at();--> statement-breakpoint
CREATE TRIGGER "operator_credential_touch_updated_at" BEFORE UPDATE ON "platform"."operator_credential" FOR EACH ROW EXECUTE FUNCTION canopy_touch_updated_at();--> statement-breakpoint
-- Operator audit is append-only for every role, the owner included, with no exception (ADR M15-0001 decision 12).
CREATE FUNCTION canopy_reject_operator_audit_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'operator_audit_event is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER "operator_audit_event_append_only" BEFORE UPDATE OR DELETE ON "platform"."operator_audit_event" FOR EACH ROW EXECUTE FUNCTION canopy_reject_operator_audit_change();--> statement-breakpoint
CREATE TRIGGER "operator_audit_event_no_truncate" BEFORE TRUNCATE ON "platform"."operator_audit_event" FOR EACH STATEMENT EXECUTE FUNCTION canopy_reject_operator_audit_change();--> statement-breakpoint

-- ---------- sign-in lookups: the support person never signs in by email (decision 11) ----------
GRANT SELECT ("support") ON "person" TO canopy_lookup;--> statement-breakpoint
GRANT SELECT ("status") ON "firm" TO canopy_lookup;--> statement-breakpoint
GRANT SELECT ("support_grant_id") ON "auth_token" TO canopy_lookup;--> statement-breakpoint
GRANT SELECT ("id", "firm_id", "ends_at", "revoked_at") ON "support_grant" TO canopy_lookup;--> statement-breakpoint
CREATE POLICY "lookup_read" ON "support_grant" AS PERMISSIVE FOR SELECT TO canopy_lookup USING (true);--> statement-breakpoint
GRANT SELECT ("support_grant_id") ON "auth_session" TO canopy_lookup;--> statement-breakpoint
-- Both now return the account status, so sign-in can refuse a paused account after the password check and every
-- request can refuse one without another query (decision 4). Dropped and recreated: the result columns change.
DROP FUNCTION canopy_login_candidates(text);--> statement-breakpoint
CREATE FUNCTION canopy_login_candidates(p_email text)
RETURNS TABLE (firm_id uuid, person_id uuid, firm_name text, status person_status, password_hash text, locked_until timestamptz, account_status account_status)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.firm_id, p.id, f.name, p.status, c.password_hash, c.locked_until, f.status
  FROM person p
  JOIN firm f ON f.id = p.firm_id
  LEFT JOIN auth_credential c ON c.firm_id = p.firm_id AND c.person_id = p.id
  WHERE p.email IS NOT NULL AND lower(p.email) = lower(p_email)
    AND p.archived_at IS NULL AND p.status <> 'UNCLAIMED' AND f.archived_at IS NULL
    AND NOT p.support AND f.status <> 'DELETED'
    AND coalesce(current_setting('app.firm_id', true), '') = ''
  ORDER BY f.name, p.firm_id
$$;
--> statement-breakpoint
-- A support session ends the moment its grant is revoked or runs out: no row, so the caller signs it out.
DROP FUNCTION canopy_find_session(text);--> statement-breakpoint
CREATE FUNCTION canopy_find_session(p_token_hash text)
RETURNS TABLE (id uuid, firm_id uuid, person_id uuid, csrf_token text, mfa_satisfied boolean, expires_at timestamptz, account_status account_status, support_grant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.id, s.firm_id, s.person_id, s.csrf_token, s.mfa_satisfied, s.expires_at, f.status, s.support_grant_id
  FROM auth_session s
  JOIN firm f ON f.id = s.firm_id
  LEFT JOIN support_grant g ON g.firm_id = s.firm_id AND g.id = s.support_grant_id
  WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL
    AND (s.support_grant_id IS NULL OR (g.revoked_at IS NULL AND g.ends_at > now()))
    AND coalesce(current_setting('app.firm_id', true), '') = ''
$$;
--> statement-breakpoint
-- Magic-link and invite tokens only: a SUPPORT token is redeemed through canopy_find_support_token alone.
CREATE OR REPLACE FUNCTION canopy_find_login_token(p_token_hash text)
RETURNS TABLE (id uuid, firm_id uuid, person_id uuid, kind text, invite_id uuid, token_hash text, expires_at timestamptz, used_at timestamptz, invite_open boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.firm_id, t.person_id, t.kind, t.invite_id, t.token_hash, t.expires_at, t.used_at,
    coalesce(i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now(), false)
  FROM auth_token t
  LEFT JOIN auth_invite i ON i.firm_id = t.firm_id AND i.id = t.invite_id
  WHERE t.token_hash = p_token_hash AND t.kind <> 'SUPPORT'
    AND coalesce(current_setting('app.firm_id', true), '') = ''
$$;
--> statement-breakpoint
-- A console-issued support token (POST /auth/support/verify): whether its grant is still live and the account's status.
CREATE FUNCTION canopy_find_support_token(p_token_hash text)
RETURNS TABLE (id uuid, firm_id uuid, person_id uuid, support_grant_id uuid, grant_ends_at timestamptz, grant_live boolean, account_status account_status, expires_at timestamptz, used_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.firm_id, t.person_id, t.support_grant_id, g.ends_at,
    g.revoked_at IS NULL AND g.ends_at > now(), f.status, t.expires_at, t.used_at
  FROM auth_token t
  JOIN support_grant g ON g.firm_id = t.firm_id AND g.id = t.support_grant_id
  JOIN firm f ON f.id = t.firm_id
  WHERE t.token_hash = p_token_hash AND t.kind = 'SUPPORT'
    AND coalesce(current_setting('app.firm_id', true), '') = ''
$$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO canopy_lookup;--> statement-breakpoint
ALTER FUNCTION canopy_login_candidates(text) OWNER TO canopy_lookup;--> statement-breakpoint
ALTER FUNCTION canopy_find_session(text) OWNER TO canopy_lookup;--> statement-breakpoint
ALTER FUNCTION canopy_find_support_token(text) OWNER TO canopy_lookup;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM canopy_lookup;--> statement-breakpoint
REVOKE ALL ON FUNCTION canopy_login_candidates(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION canopy_find_session(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION canopy_find_support_token(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION canopy_login_candidates(text) TO canopy_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION canopy_find_session(text) TO canopy_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION canopy_find_support_token(text) TO canopy_app;--> statement-breakpoint

-- ---------- canopy_platform: owner of the cross-wall functions ----------
-- No login, no BYPASSRLS, not a member of canopy_app or canopy_operator. The migrating user joins it only to hand it
-- the functions; createDatabase refuses a request login that can become it. Its rights are the grants below, under
-- the tables' own RLS policies (to public): each function sets the one firm it works on for its own statements and
-- puts the caller's settings back before returning.
DO $$
BEGIN
  CREATE ROLE canopy_platform NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
EXCEPTION WHEN OTHERS THEN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'canopy_platform') THEN
    RAISE;
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT pg_has_role(current_user, 'canopy_platform', 'SET') THEN
    GRANT canopy_platform TO CURRENT_USER;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF NOT pg_has_role(current_user, 'canopy_platform', 'SET') THEN
    RAISE;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO canopy_platform;--> statement-breakpoint
GRANT USAGE ON SCHEMA platform TO canopy_platform;--> statement-breakpoint
GRANT SELECT ON "platform"."plan", "platform"."account_override" TO canopy_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "firm" TO canopy_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "client", "person", "auth_invite", "audit_event", "domain_event", "auth_token" TO canopy_platform;--> statement-breakpoint
GRANT SELECT ON "support_grant", "company", "unit", "evidence", "compliance_instance", "membership", "auth_session" TO canopy_platform;--> statement-breakpoint

-- Sets the tenant settings for one firm as a firm-wide system context and returns the caller's, to put back.
CREATE FUNCTION canopy_platform_enter(p_firm uuid) RETURNS text[]
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE previous text[] := ARRAY[
  coalesce(current_setting('app.firm_id', true), ''),
  coalesce(current_setting('app.all_clients', true), ''),
  coalesce(current_setting('app.firm_staff', true), ''),
  coalesce(current_setting('app.client_ids', true), ''),
  coalesce(current_setting('app.person_id', true), '')];
BEGIN
  PERFORM set_config('app.firm_id', p_firm::text, true), set_config('app.all_clients', 'on', true),
    set_config('app.firm_staff', 'on', true), set_config('app.client_ids', '', true),
    set_config('app.person_id', '', true);
  RETURN previous;
END
$$;
--> statement-breakpoint
CREATE FUNCTION canopy_platform_leave(p_previous text[]) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM set_config('app.firm_id', p_previous[1], true), set_config('app.all_clients', p_previous[2], true),
    set_config('app.firm_staff', p_previous[3], true), set_config('app.client_ids', p_previous[4], true),
    set_config('app.person_id', p_previous[5], true);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION canopy_platform_enter(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION canopy_platform_leave(text[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION canopy_platform_enter(uuid), canopy_platform_leave(text[]) TO canopy_platform;--> statement-breakpoint

-- The app's own account: kind, status, plan and effective limits (plan overlaid with the override). Tenant context.
CREATE FUNCTION app_account()
RETURNS TABLE (kind account_kind, status account_status, plan_code text, trial_ends_on date, limits jsonb, features text[])
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT f.kind, f.status, f.plan_code, f.trial_ends_on,
    p.limits || coalesce(o.limits, '{}'::jsonb),
    ARRAY(SELECT DISTINCT unnest(p.features || coalesce(o.features, '{}'::text[])) ORDER BY 1)
  FROM firm f
  JOIN platform.plan p ON p.code = f.plan_code
  LEFT JOIN platform.account_override o ON o.account_id = f.id
  WHERE f.id = app_firm_id()
$$;
--> statement-breakpoint

-- Creates an account's firm row in PROVISIONING (decision 10). Returns its id.
CREATE FUNCTION platform_create_account(
  p_name text, p_kind account_kind, p_plan_code text, p_trial_ends_on date, p_settings jsonb, p_profile jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  new_id uuid := canopy_uuid_v7();
  previous text[];
BEGIN
  previous := canopy_platform_enter(new_id);
  INSERT INTO firm (id, name, settings, kind, status, plan_code, trial_ends_on, profile)
  VALUES (new_id, p_name, p_settings, p_kind, 'PROVISIONING', p_plan_code, p_trial_ends_on, coalesce(p_profile, '{}'::jsonb));
  PERFORM canopy_platform_leave(previous);
  RETURN new_id;
END
$$;
--> statement-breakpoint

-- The tenant side of provisioning, for a firm still PROVISIONING with no people (decision 8): the enterprise client
-- (p_client_name null for a consultancy), the owner as an INVITED person, the owner's FIRM_ADMIN invite and the
-- account.created and person.invited outbox events. Returns the owner person, invite and client ids.
CREATE FUNCTION platform_provision_account(
  p_firm uuid, p_client_name text, p_client_settings jsonb, p_owner_name text, p_owner_name_normalized text,
  p_owner_email text, p_invite_expires_at timestamptz, p_operator uuid, p_request_id text)
RETURNS TABLE (owner_id uuid, invite_id uuid, client_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  previous text[];
  f firm%ROWTYPE;
  v_owner uuid := canopy_uuid_v7();
  v_invite uuid := canopy_uuid_v7();
  v_client uuid;
  v_actor jsonb := jsonb_build_object('kind', 'OPERATOR', 'operatorId', p_operator);
BEGIN
  previous := canopy_platform_enter(p_firm);
  SELECT * INTO f FROM firm WHERE id = p_firm;
  IF NOT FOUND OR f.status <> 'PROVISIONING' OR EXISTS (SELECT 1 FROM person WHERE firm_id = p_firm) THEN
    RAISE EXCEPTION 'platform_provision_account: % is not a new PROVISIONING account', p_firm
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_client_name IS NOT NULL THEN
    IF f.kind <> 'ENTERPRISE' THEN
      RAISE EXCEPTION 'platform_provision_account: only an ENTERPRISE account gets a client' USING ERRCODE = 'check_violation';
    END IF;
    v_client := canopy_uuid_v7();
    INSERT INTO client (id, firm_id, name, settings) VALUES (v_client, p_firm, p_client_name, p_client_settings);
  END IF;
  INSERT INTO person (id, firm_id, display_name, name_normalized, email, status)
  VALUES (v_owner, p_firm, p_owner_name, p_owner_name_normalized, p_owner_email, 'INVITED');
  INSERT INTO auth_invite (id, firm_id, person_id, email, role, created_by_id, expires_at)
  VALUES (v_invite, p_firm, v_owner, p_owner_email, 'FIRM_ADMIN', v_owner, p_invite_expires_at);
  INSERT INTO domain_event (firm_id, client_id, type, actor, request_id, aggregate_type, aggregate_id, aggregate_version, data)
  VALUES
    (p_firm, NULL, 'account.created', v_actor, p_request_id, 'account', p_firm, f.version,
     jsonb_build_object('accountId', p_firm, 'kind', f.kind, 'planCode', f.plan_code, 'status', f.status)),
    (p_firm, NULL, 'person.invited', v_actor, p_request_id, 'person', v_owner, 1,
     jsonb_build_object('personId', v_owner, 'inviteId', v_invite, 'role', 'FIRM_ADMIN', 'clientId', NULL));
  PERFORM canopy_platform_leave(previous);
  RETURN QUERY SELECT v_owner, v_invite, v_client;
END
$$;
--> statement-breakpoint

-- An operator change in the account's own audit trail (actor OPERATOR, entity account) and, when p_event_type is
-- given, its account.* outbox event (decision 12). p_before and p_after carry account fields only, never people.
CREATE FUNCTION platform_record_account_event(
  p_firm uuid, p_action audit_action, p_before jsonb, p_after jsonb, p_reason text, p_request_id text,
  p_operator uuid, p_event_type text, p_event_data jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  previous text[];
  v_version integer;
BEGIN
  IF p_event_type IS NOT NULL AND p_event_type !~ '^(account|support_access)\.[a-z_]+$' THEN
    RAISE EXCEPTION 'platform_record_account_event: % is not an account event', p_event_type
      USING ERRCODE = 'check_violation';
  END IF;
  -- Account fields only (audit note I4 on PR #123): no person's name, email or phone in the operator's entries.
  IF coalesce(p_before, '{}'::jsonb) ?| ARRAY['email', 'displayName', 'phone', 'ownerEmail', 'ownerName']
     OR coalesce(p_after, '{}'::jsonb) ?| ARRAY['email', 'displayName', 'phone', 'ownerEmail', 'ownerName'] THEN
    RAISE EXCEPTION 'platform_record_account_event: before and after carry account fields only'
      USING ERRCODE = 'check_violation';
  END IF;
  previous := canopy_platform_enter(p_firm);
  SELECT version INTO v_version FROM firm WHERE id = p_firm;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'platform_record_account_event: no account %', p_firm USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO audit_event (firm_id, client_id, request_id, actor_id, actor_kind, action, entity_type, entity_id, before, after, reason)
  VALUES (p_firm, NULL, p_request_id, NULL, 'OPERATOR', p_action, 'account', p_firm, p_before, p_after, p_reason);
  IF p_event_type IS NOT NULL THEN
    INSERT INTO domain_event (firm_id, client_id, type, actor, request_id, aggregate_type, aggregate_id, aggregate_version, data)
    VALUES (p_firm, NULL, p_event_type, jsonb_build_object('kind', 'OPERATOR', 'operatorId', p_operator), p_request_id,
      'account', p_firm, v_version, coalesce(p_event_data, '{}'::jsonb));
  END IF;
  PERFORM canopy_platform_leave(previous);
END
$$;
--> statement-breakpoint

-- The one-time SUPPORT token the console opens the app with (decision 11). It works for SUPPORT_TOKEN_SECONDS (60);
-- 90 allows for clock skew between the API and the database. The operator names the account it read the
-- grant under; a grant of another account is not found. Refuses a grant that is not live or an account that is not
-- TRIAL or ACTIVE.
CREATE FUNCTION platform_issue_support_token(p_firm uuid, p_grant uuid, p_token_hash text, p_expires_at timestamptz)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  previous text[];
  g RECORD;
BEGIN
  IF p_token_hash !~ '^[0-9a-f]{64}$' OR p_expires_at > now() + interval '90 seconds' OR p_expires_at <= now() THEN
    RAISE EXCEPTION 'platform_issue_support_token: bad token or expiry' USING ERRCODE = 'check_violation';
  END IF;
  previous := canopy_platform_enter(p_firm);
  SELECT sg.support_person_id, sg.ends_at, sg.revoked_at, f.status INTO g
  FROM support_grant sg JOIN firm f ON f.id = sg.firm_id WHERE sg.firm_id = p_firm AND sg.id = p_grant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'platform_issue_support_token: no grant %', p_grant USING ERRCODE = 'no_data_found';
  END IF;
  IF g.revoked_at IS NOT NULL OR g.ends_at <= now() OR g.status NOT IN ('TRIAL', 'ACTIVE') THEN
    RAISE EXCEPTION 'platform_issue_support_token: grant % is not live', p_grant USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO auth_token (firm_id, person_id, kind, support_grant_id, token_hash, expires_at)
  VALUES (p_firm, g.support_person_id, 'SUPPORT', p_grant, p_token_hash, p_expires_at);
  PERFORM canopy_platform_leave(previous);
END
$$;
--> statement-breakpoint

-- Counts for the console and the nightly snapshot: never a row, a name or an email.
CREATE FUNCTION platform_usage(p_firm uuid)
RETURNS TABLE (companies integer, units integer, users integer, storage_bytes bigint, instances integer, active_users_30d integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE previous text[];
BEGIN
  previous := canopy_platform_enter(p_firm);
  RETURN QUERY SELECT
    (SELECT count(*)::integer FROM company WHERE archived_at IS NULL),
    (SELECT count(*)::integer FROM unit WHERE archived_at IS NULL),
    (SELECT count(*)::integer FROM person p WHERE p.archived_at IS NULL AND NOT p.support
       AND p.status IN ('ACTIVE', 'INVITED')
       AND (EXISTS (SELECT 1 FROM membership m WHERE m.person_id = p.id AND m.archived_at IS NULL
                    AND (m.expires_at IS NULL OR m.expires_at > now()))
            -- A pending invite holds a seat, so invites cannot run past the user limit.
            OR EXISTS (SELECT 1 FROM auth_invite i WHERE i.person_id = p.id AND i.accepted_at IS NULL
                       AND i.revoked_at IS NULL AND i.expires_at > now()))),
    (SELECT coalesce(sum(size_bytes), 0)::bigint FROM evidence WHERE archived_at IS NULL),
    (SELECT count(*)::integer FROM compliance_instance WHERE archived_at IS NULL),
    (SELECT count(DISTINCT s.person_id)::integer FROM auth_session s JOIN person p ON p.id = s.person_id
       WHERE NOT p.support AND s.last_seen_at > now() - interval '30 days');
  PERFORM canopy_platform_leave(previous);
END
$$;
--> statement-breakpoint

-- The owner the operator invited at provisioning (the FIRM_ADMIN invite the owner "created" for themselves):
-- email, name and whether they accepted. The operator typed these in; nothing else about people leaves the tenant.
CREATE FUNCTION platform_account_owner(p_firm uuid)
RETURNS TABLE (email text, display_name text, accepted boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE previous text[];
BEGIN
  previous := canopy_platform_enter(p_firm);
  RETURN QUERY SELECT i.email::text, p.display_name::text, i.accepted_at IS NOT NULL
    FROM auth_invite i JOIN person p ON p.firm_id = i.firm_id AND p.id = i.person_id
    WHERE i.role = 'FIRM_ADMIN' AND i.created_by_id = i.person_id
    ORDER BY i.created_at LIMIT 1;
  PERFORM canopy_platform_leave(previous);
END
$$;
--> statement-breakpoint
-- The app's own usage for plan limits and the account page: the whole firm's counts whatever the caller's client
-- scope, so a client admin's unit limit counts every client (decision 6). Tenant context required.
CREATE FUNCTION app_usage()
RETURNS TABLE (companies integer, units integer, users integer, storage_bytes bigint, instances integer, active_users_30d integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF app_firm_id() IS NULL THEN
    RAISE EXCEPTION 'app_usage needs a tenant context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT * FROM platform_usage(app_firm_id());
END
$$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO canopy_platform;--> statement-breakpoint
ALTER FUNCTION app_account() OWNER TO canopy_platform;--> statement-breakpoint
ALTER FUNCTION app_usage() OWNER TO canopy_platform;--> statement-breakpoint
ALTER FUNCTION platform_create_account(text, account_kind, text, date, jsonb, jsonb) OWNER TO canopy_platform;--> statement-breakpoint
ALTER FUNCTION platform_provision_account(uuid, text, jsonb, text, text, text, timestamptz, uuid, text) OWNER TO canopy_platform;--> statement-breakpoint
ALTER FUNCTION platform_record_account_event(uuid, audit_action, jsonb, jsonb, text, text, uuid, text, jsonb) OWNER TO canopy_platform;--> statement-breakpoint
ALTER FUNCTION platform_issue_support_token(uuid, uuid, text, timestamptz) OWNER TO canopy_platform;--> statement-breakpoint
ALTER FUNCTION platform_usage(uuid) OWNER TO canopy_platform;--> statement-breakpoint
ALTER FUNCTION platform_account_owner(uuid) OWNER TO canopy_platform;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM canopy_platform;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_account() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_usage() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION platform_create_account(text, account_kind, text, date, jsonb, jsonb) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION platform_provision_account(uuid, text, jsonb, text, text, text, timestamptz, uuid, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION platform_record_account_event(uuid, audit_action, jsonb, jsonb, text, text, uuid, text, jsonb) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION platform_issue_support_token(uuid, uuid, text, timestamptz) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION platform_usage(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION platform_account_owner(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_account() TO canopy_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_usage() TO canopy_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_create_account(text, account_kind, text, date, jsonb, jsonb) TO canopy_operator;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_provision_account(uuid, text, jsonb, text, text, text, timestamptz, uuid, text) TO canopy_operator;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_record_account_event(uuid, audit_action, jsonb, jsonb, text, text, uuid, text, jsonb) TO canopy_operator;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_issue_support_token(uuid, uuid, text, timestamptz) TO canopy_operator;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_usage(uuid) TO canopy_operator;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_account_owner(uuid) TO canopy_operator;
