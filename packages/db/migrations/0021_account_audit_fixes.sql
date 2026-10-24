-- Follow-up to 0019 and 0020 (PR #140 merged before these reached it): the regenerated M15 patch and the #140 audit
-- fixes, as a new migration since 0019 and 0020 are applied. ADR M3-0002.

-- ---------- support_grant: revoked, never re-pointed or stretched (audit of #140, Low 4 and 5) ----------
REVOKE UPDATE ON "support_grant" FROM canopy_app;--> statement-breakpoint
GRANT UPDATE ("revoked_at", "revoked_by_id", "updated_at") ON "support_grant" TO canopy_app;--> statement-breakpoint
ALTER TABLE "support_grant" ADD CONSTRAINT "support_grant_length_check" CHECK (ends_at <= starts_at + interval '30 days');--> statement-breakpoint

-- ---------- sign-in lookups never find the support person outside a support grant (audit of #140, Medium 3) ----------
-- A support session ends the moment its grant is revoked or runs out: no row, so the caller signs it out. A session of
-- the support person without a grant is never found.
CREATE OR REPLACE FUNCTION canopy_find_session(p_token_hash text)
RETURNS TABLE (id uuid, firm_id uuid, person_id uuid, csrf_token text, mfa_satisfied boolean, expires_at timestamptz, account_status account_status, support_grant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.id, s.firm_id, s.person_id, s.csrf_token, s.mfa_satisfied, s.expires_at, f.status, s.support_grant_id
  FROM auth_session s
  JOIN firm f ON f.id = s.firm_id
  JOIN person p ON p.firm_id = s.firm_id AND p.id = s.person_id
  LEFT JOIN support_grant g ON g.firm_id = s.firm_id AND g.id = s.support_grant_id
  WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL
    AND (s.support_grant_id IS NULL OR (g.revoked_at IS NULL AND g.ends_at > now()))
    -- The support person has no session but a support one (audit of #140, Medium 3).
    AND (s.support_grant_id IS NOT NULL OR NOT p.support)
    AND coalesce(current_setting('app.firm_id', true), '') = ''
$$;
--> statement-breakpoint
-- Magic-link and invite tokens only, never the support person's: a SUPPORT token is redeemed through
-- canopy_find_support_token alone.
CREATE OR REPLACE FUNCTION canopy_find_login_token(p_token_hash text)
RETURNS TABLE (id uuid, firm_id uuid, person_id uuid, kind text, invite_id uuid, token_hash text, expires_at timestamptz, used_at timestamptz, invite_open boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.firm_id, t.person_id, t.kind, t.invite_id, t.token_hash, t.expires_at, t.used_at,
    coalesce(i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now(), false)
  FROM auth_token t
  JOIN person p ON p.firm_id = t.firm_id AND p.id = t.person_id
  LEFT JOIN auth_invite i ON i.firm_id = t.firm_id AND i.id = t.invite_id
  WHERE t.token_hash = p_token_hash AND t.kind <> 'SUPPORT' AND NOT p.support
    AND coalesce(current_setting('app.firm_id', true), '') = ''
$$;
--> statement-breakpoint
-- A console-issued support token (POST /auth/support/verify): whether its grant is still live and the account's status.
CREATE OR REPLACE FUNCTION canopy_find_support_token(p_token_hash text)
RETURNS TABLE (id uuid, firm_id uuid, person_id uuid, support_grant_id uuid, grant_ends_at timestamptz, grant_live boolean, account_status account_status, expires_at timestamptz, used_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.firm_id, t.person_id, t.support_grant_id, g.ends_at,
    g.revoked_at IS NULL AND g.ends_at > now(), f.status, t.expires_at, t.used_at
  FROM auth_token t
  JOIN support_grant g ON g.firm_id = t.firm_id AND g.id = t.support_grant_id
  JOIN person p ON p.firm_id = t.firm_id AND p.id = t.person_id
  JOIN firm f ON f.id = t.firm_id
  WHERE t.token_hash = p_token_hash AND t.kind = 'SUPPORT' AND p.support
    AND coalesce(current_setting('app.firm_id', true), '') = ''
$$;
--> statement-breakpoint

-- ---------- operator functions (audit of #140, Low 4 and 6) ----------
-- An operator change in the account's own audit trail (actor OPERATOR, entity account) and, when p_event_type is
-- given, its account.* outbox event (decision 12). p_before and p_after carry account fields only, never people.
CREATE OR REPLACE FUNCTION platform_record_account_event(
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
  -- The account actions only (audit of #140, Low 6): created, changed, or moved between statuses.
  IF p_action NOT IN ('CREATE', 'UPDATE', 'TRANSITION') THEN
    RAISE EXCEPTION 'platform_record_account_event: % is not an account action', p_action
      USING ERRCODE = 'check_violation';
  END IF;
  -- Account fields only (audit note I4 on PR #123), at any depth (audit of #140, Low 6): no person's name, email or
  -- phone in the operator's entries.
  IF jsonb_path_exists(jsonb_build_array(p_before, p_after),
       'lax $.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^(email|displayName|phone|ownerEmail|ownerName)$")') THEN
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
CREATE OR REPLACE FUNCTION platform_issue_support_token(p_firm uuid, p_grant uuid, p_token_hash text, p_expires_at timestamptz)
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
  -- Only the account's support person: a grant pointed at anyone else is not found (audit of #140, Low 4).
  SELECT sg.support_person_id, sg.ends_at, sg.revoked_at, f.status INTO g
  FROM support_grant sg
  JOIN firm f ON f.id = sg.firm_id
  JOIN person p ON p.firm_id = sg.firm_id AND p.id = sg.support_person_id AND p.support
  WHERE sg.firm_id = p_firm AND sg.id = p_grant;
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

-- ---------- the owner accepting their invite opens the account (regenerated M15 patch) ----------
-- Replaces platform_account_owner: the operator no longer reads the owner's email or name, only the status.
DROP FUNCTION platform_account_owner(uuid);--> statement-breakpoint
GRANT UPDATE ("status", "onboarded_at", "version") ON "firm" TO canopy_platform;--> statement-breakpoint
GRANT INSERT ON "platform"."operator_audit_event" TO canopy_platform;--> statement-breakpoint
-- The owner accepting their invite opens the account (ADR M15-0001 decision 3): PROVISIONING becomes TRIAL when
-- trial_ends_on is set, else ACTIVE, in the accepting transaction, with the account's audit row (actor: the owner),
-- the account.status_changed outbox event and the system's ACCOUNT_ACTIVATE operator audit entry. Any other
-- FIRM_ADMIN acceptance, or a firm that has left PROVISIONING, changes nothing.
CREATE FUNCTION canopy_activate_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  previous text[];
  f firm%ROWTYPE;
  v_request text := coalesce(nullif(current_setting('app.request_id', true), ''), 'invite-accept');
BEGIN
  previous := canopy_platform_enter(NEW.firm_id);
  UPDATE firm SET status = CASE WHEN trial_ends_on IS NULL THEN 'ACTIVE' ELSE 'TRIAL' END::account_status,
      onboarded_at = now(), version = version + 1
    WHERE id = NEW.firm_id AND status = 'PROVISIONING'
    RETURNING * INTO f;
  IF FOUND THEN
    INSERT INTO audit_event (firm_id, client_id, request_id, actor_id, actor_kind, action, entity_type, entity_id, before, after, reason)
    VALUES (f.id, NULL, v_request, NEW.person_id, 'PERSON', 'TRANSITION', 'account', f.id,
      jsonb_build_object('status', 'PROVISIONING'), jsonb_build_object('status', f.status), NULL);
    INSERT INTO domain_event (firm_id, client_id, type, actor, request_id, aggregate_type, aggregate_id, aggregate_version, data)
    VALUES (f.id, NULL, 'account.status_changed', jsonb_build_object('kind', 'PERSON', 'personId', NEW.person_id),
      v_request, 'account', f.id, f.version,
      jsonb_build_object('accountId', f.id, 'from', 'PROVISIONING', 'to', f.status));
    INSERT INTO platform.operator_audit_event (operator_id, action, account_id, before, after, request_id)
    VALUES (NULL, 'ACCOUNT_ACTIVATE', f.id, jsonb_build_object('status', 'PROVISIONING'),
      jsonb_build_object('status', f.status), v_request);
  END IF;
  PERFORM canopy_platform_leave(previous);
  RETURN NULL;
END
$$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO canopy_platform;--> statement-breakpoint
ALTER FUNCTION canopy_activate_account() OWNER TO canopy_platform;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM canopy_platform;--> statement-breakpoint
REVOKE ALL ON FUNCTION canopy_activate_account() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "auth_invite_activates_account" AFTER UPDATE OF "accepted_at" ON "auth_invite" FOR EACH ROW WHEN (OLD.accepted_at IS NULL AND NEW.accepted_at IS NOT NULL AND NEW.role = 'FIRM_ADMIN') EXECUTE FUNCTION canopy_activate_account();
--> statement-breakpoint

-- ---------- the deletion clock is the database's (audit of #140, Medium 2) ----------
-- The 30-day grace of ADR M15-0002 runs from deletion_requested_at, so no role may choose it: moving into
-- PENDING_DELETION stamps now(), and any other change to it but clearing it (a cancelled deletion) is refused.
CREATE FUNCTION canopy_firm_deletion_clock() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'PENDING_DELETION' AND (TG_OP = 'INSERT' OR OLD.status <> 'PENDING_DELETION') THEN
    NEW.deletion_requested_at := now();
  ELSIF NEW.deletion_requested_at IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW.deletion_requested_at IS DISTINCT FROM OLD.deletion_requested_at) THEN
    RAISE EXCEPTION 'firm.deletion_requested_at is set by the database when deletion is requested'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "firm_deletion_clock" BEFORE INSERT OR UPDATE ON "firm" FOR EACH ROW EXECUTE FUNCTION canopy_firm_deletion_clock();--> statement-breakpoint

-- ---------- the support person's one way in is a support grant (decision 11; audit of #140, Medium 3) ----------
-- No password, no magic-link or invite token, no invite and no session without a grant, whichever role writes it.
-- Owned by canopy_lookup, which reads person.support in every firm (lookup_read), so the check sees the person
-- whatever the writer's own client scope.
CREATE FUNCTION canopy_refuse_support_person() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM person p WHERE p.firm_id = NEW.firm_id AND p.id = NEW.person_id AND p.support) THEN
    RAISE EXCEPTION '%: the support person signs in only through a support grant', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO canopy_lookup;--> statement-breakpoint
ALTER FUNCTION canopy_refuse_support_person() OWNER TO canopy_lookup;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM canopy_lookup;--> statement-breakpoint
CREATE TRIGGER "auth_credential_not_support" BEFORE INSERT OR UPDATE ON "auth_credential" FOR EACH ROW EXECUTE FUNCTION canopy_refuse_support_person();--> statement-breakpoint
CREATE TRIGGER "auth_token_not_support" BEFORE INSERT ON "auth_token" FOR EACH ROW WHEN (NEW.kind <> 'SUPPORT') EXECUTE FUNCTION canopy_refuse_support_person();--> statement-breakpoint
CREATE TRIGGER "auth_session_not_support" BEFORE INSERT ON "auth_session" FOR EACH ROW WHEN (NEW.support_grant_id IS NULL) EXECUTE FUNCTION canopy_refuse_support_person();--> statement-breakpoint
CREATE TRIGGER "auth_invite_not_support" BEFORE INSERT ON "auth_invite" FOR EACH ROW EXECUTE FUNCTION canopy_refuse_support_person();
