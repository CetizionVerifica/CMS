-- Customer accounts, part 3 (ADR M15-0001 decisions 3, 6, 8, 10; ADR M3-0003): the operator resends the
-- owner's invite, the M9 jobs end trials and take the nightly usage snapshot, and the owner waits for the library copy. Custom migration: Drizzle Kit does
-- not model functions or grants. Every function is owned by canopy_platform, like those of migration 0020.

-- The library copy gate (ADR M15-0001 decision 8): an account opens only once M6 has copied the master library.
-- Firms that already left PROVISIONING have their library, so they are backfilled with their creation time; FORCE
-- RLS binds the owner, so each firm is updated as itself (as in 0019).
ALTER TABLE "firm" ADD COLUMN "library_copied_at" timestamp with time zone;--> statement-breakpoint
DO $$
DECLARE f uuid;
BEGIN
  FOR f IN SELECT canopy_list_firm_ids() LOOP
    PERFORM set_config('app.firm_id', f::text, true), set_config('app.firm_staff', 'on', true);
    UPDATE "firm" SET "library_copied_at" = "created_at" WHERE "id" = f AND "status" <> 'PROVISIONING';
  END LOOP;
  PERFORM set_config('app.firm_id', '', true), set_config('app.firm_staff', '', true);
END
$$;
--> statement-breakpoint
GRANT UPDATE ("library_copied_at") ON "firm" TO canopy_platform;--> statement-breakpoint
GRANT UPDATE ("revoked_at") ON "auth_invite" TO canopy_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "platform"."usage_snapshot" TO canopy_platform;--> statement-breakpoint

-- A fresh owner invite for a PROVISIONING account (POST /accounts/{id}/owner-invite): the owner's open invites are
-- revoked, so earlier links stop working, and person.invited makes M9 email the new one. Returns the new invite id.
CREATE FUNCTION platform_resend_owner_invite(p_firm uuid, p_expires_at timestamptz, p_operator uuid, p_request_id text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  previous text[];
  f firm%ROWTYPE;
  owner_invite auth_invite%ROWTYPE;
  v_invite uuid := canopy_uuid_v7();
BEGIN
  IF p_expires_at <= now() OR p_expires_at > now() + interval '30 days' THEN
    RAISE EXCEPTION 'platform_resend_owner_invite: bad expiry' USING ERRCODE = 'check_violation';
  END IF;
  previous := canopy_platform_enter(p_firm);
  SELECT * INTO f FROM firm WHERE id = p_firm;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'platform_resend_owner_invite: no account %', p_firm USING ERRCODE = 'no_data_found';
  END IF;
  IF f.status <> 'PROVISIONING' THEN
    RAISE EXCEPTION 'platform_resend_owner_invite: % is not PROVISIONING', p_firm USING ERRCODE = 'check_violation';
  END IF;
  -- The owner's invite is the FIRM_ADMIN invite the owner "created" for themselves at provisioning.
  SELECT * INTO owner_invite FROM auth_invite
    WHERE firm_id = p_firm AND role = 'FIRM_ADMIN' AND created_by_id = person_id
    ORDER BY created_at LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'platform_resend_owner_invite: % has no owner invite', p_firm USING ERRCODE = 'no_data_found';
  END IF;
  UPDATE auth_invite SET revoked_at = now()
    WHERE firm_id = p_firm AND person_id = owner_invite.person_id AND accepted_at IS NULL AND revoked_at IS NULL;
  INSERT INTO auth_invite (id, firm_id, person_id, email, role, created_by_id, expires_at)
  VALUES (v_invite, p_firm, owner_invite.person_id, owner_invite.email, 'FIRM_ADMIN', owner_invite.person_id, p_expires_at);
  INSERT INTO domain_event (firm_id, client_id, type, actor, request_id, aggregate_type, aggregate_id, aggregate_version, data)
  VALUES (p_firm, NULL, 'person.invited', jsonb_build_object('kind', 'OPERATOR', 'operatorId', p_operator), p_request_id,
    'person', owner_invite.person_id, 1,
    jsonb_build_object('personId', owner_invite.person_id, 'inviteId', v_invite, 'role', 'FIRM_ADMIN', 'clientId', NULL));
  PERFORM canopy_platform_leave(previous);
  RETURN v_invite;
END
$$;
--> statement-breakpoint

-- The account jobs run in a system context only (audit of #171, Low 3): firm-wide, firm staff and no person. A
-- consultant scoped to some clients is firm staff too, and must not end its own trial or stamp the library copy.
CREATE FUNCTION app_system_job() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT app_firm_staff() AND app_all_clients() AND app_person_id() IS NULL $$;
--> statement-breakpoint
-- The M9 trial-end job, run in the account's own system context: a TRIAL whose trial_ends_on is before p_now's date
-- in the account's time zone becomes SUSPENDED (decision 3), with the account's audit row and account.status_changed
-- (actor SYSTEM, the job) and the system's ACCOUNT_SUSPEND operator entry. True when it suspended the account.
CREATE FUNCTION app_end_trial(p_now timestamptz, p_job text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_firm uuid := app_firm_id();
  v_request text := coalesce(nullif(current_setting('app.request_id', true), ''), p_job);
  f firm%ROWTYPE;
BEGIN
  IF v_firm IS NULL OR NOT app_system_job() THEN
    RAISE EXCEPTION 'app_end_trial needs the account''s system context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_job IS NULL OR length(p_job) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'app_end_trial: bad job name' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE firm SET status = 'SUSPENDED', version = version + 1
    WHERE id = v_firm AND status = 'TRIAL'
      AND trial_ends_on < (p_now AT TIME ZONE coalesce(profile->>'timeZone', 'Asia/Kolkata'))::date
    RETURNING * INTO f;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO audit_event (firm_id, client_id, request_id, actor_id, actor_kind, action, entity_type, entity_id, before, after, reason)
  VALUES (v_firm, NULL, v_request, NULL, 'SYSTEM', 'TRANSITION', 'account', v_firm,
    jsonb_build_object('status', 'TRIAL'), jsonb_build_object('status', 'SUSPENDED'), 'Trial ended');
  INSERT INTO domain_event (firm_id, client_id, type, actor, request_id, aggregate_type, aggregate_id, aggregate_version, data)
  VALUES (v_firm, NULL, 'account.status_changed', jsonb_build_object('kind', 'SYSTEM', 'job', p_job), v_request,
    'account', v_firm, f.version, jsonb_build_object('accountId', v_firm, 'from', 'TRIAL', 'to', 'SUSPENDED'));
  INSERT INTO platform.operator_audit_event (operator_id, action, account_id, before, after, reason, request_id)
  VALUES (NULL, 'ACCOUNT_SUSPEND', v_firm, jsonb_build_object('status', 'TRIAL'),
    jsonb_build_object('status', 'SUSPENDED'), 'Trial ended', v_request);
  RETURN true;
END
$$;
--> statement-breakpoint

-- The M9 nightly usage job, run in the account's own system context: today's counts (platform_usage) into
-- usage_snapshot, replacing a snapshot already taken that day.
CREATE FUNCTION app_take_usage_snapshot(p_on date)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_firm uuid := app_firm_id();
BEGIN
  IF v_firm IS NULL OR NOT app_system_job() THEN
    RAISE EXCEPTION 'app_take_usage_snapshot needs the account''s system context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO platform.usage_snapshot (account_id, taken_on, companies, units, users, storage_bytes, active_users_30d, instances)
  SELECT v_firm, p_on, u.companies, u.units, u.users, u.storage_bytes, u.active_users_30d, u.instances
    FROM platform_usage(v_firm) u
  ON CONFLICT (account_id, taken_on) DO UPDATE SET companies = EXCLUDED.companies, units = EXCLUDED.units,
    users = EXCLUDED.users, storage_bytes = EXCLUDED.storage_bytes, active_users_30d = EXCLUDED.active_users_30d,
    instances = EXCLUDED.instances;
END
$$;
--> statement-breakpoint
-- M6's account.created handler, in the new account's own system context, in the transaction that copied the
-- library: records the copy once. Only while the account is PROVISIONING and the time is unset; true when it set it.
CREATE FUNCTION app_mark_library_copied()
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF app_firm_id() IS NULL OR NOT app_system_job() THEN
    RAISE EXCEPTION 'app_mark_library_copied needs the account''s system context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE firm SET library_copied_at = now()
    WHERE id = app_firm_id() AND status = 'PROVISIONING' AND library_copied_at IS NULL;
  RETURN FOUND;
END
$$;
--> statement-breakpoint
-- The owner's acceptance waits for the copy: canopy_activate_account (migration 0021) now refuses to open an account
-- whose library is not copied yet, so the accepting transaction rolls back.
CREATE OR REPLACE FUNCTION canopy_activate_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  previous text[];
  f firm%ROWTYPE;
  v_request text := coalesce(nullif(current_setting('app.request_id', true), ''), 'invite-accept');
BEGIN
  previous := canopy_platform_enter(NEW.firm_id);
  IF EXISTS (SELECT 1 FROM firm WHERE id = NEW.firm_id AND status = 'PROVISIONING' AND library_copied_at IS NULL) THEN
    RAISE EXCEPTION 'canopy_activate_account: the account is still being set up' USING ERRCODE = 'check_violation';
  END IF;
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
ALTER FUNCTION platform_resend_owner_invite(uuid, timestamptz, uuid, text) OWNER TO canopy_platform;--> statement-breakpoint
ALTER FUNCTION app_end_trial(timestamptz, text) OWNER TO canopy_platform;--> statement-breakpoint
ALTER FUNCTION app_take_usage_snapshot(date) OWNER TO canopy_platform;--> statement-breakpoint
ALTER FUNCTION app_mark_library_copied() OWNER TO canopy_platform;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM canopy_platform;--> statement-breakpoint
REVOKE ALL ON FUNCTION platform_resend_owner_invite(uuid, timestamptz, uuid, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_end_trial(timestamptz, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_take_usage_snapshot(date) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_mark_library_copied() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_resend_owner_invite(uuid, timestamptz, uuid, text) TO canopy_operator;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_end_trial(timestamptz, text) TO canopy_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_take_usage_snapshot(date) TO canopy_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_mark_library_copied() TO canopy_app;
