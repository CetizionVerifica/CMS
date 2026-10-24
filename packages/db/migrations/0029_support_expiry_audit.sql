-- A support grant that runs out (rather than being revoked) gets its SUPPORT_ACCESS_END in the operator trail too (ADR
-- M15-0001 decision 11). M9's nightly account job closes each expired grant in the account's system context
-- (supportGrants.closeExpired); this function, owned by canopy_platform as the 0024 trigger is, writes the entry,
-- since canopy_app cannot write platform.operator_audit_event. It records a grant only while it is still open (not
-- revoked, over by p_now, its support person still holding a live membership), so the close that follows makes a
-- second call a no-op. Custom migration: Drizzle Kit does not model functions or grants. Ids, the level and times
-- only, never a person.
CREATE FUNCTION app_record_support_expiry(p_grant uuid, p_now timestamptz)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_firm uuid := app_firm_id();
  v_request text := coalesce(nullif(current_setting('app.request_id', true), ''), 'support-expiry');
  g support_grant%ROWTYPE;
BEGIN
  IF v_firm IS NULL OR NOT app_system_job() THEN
    RAISE EXCEPTION 'app_record_support_expiry needs the account''s system context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO g FROM support_grant
    WHERE id = p_grant AND firm_id = v_firm AND revoked_at IS NULL AND ends_at <= p_now;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM membership m
                  WHERE m.firm_id = v_firm AND m.person_id = g.support_person_id AND m.archived_at IS NULL) THEN
    RETURN false;
  END IF;
  INSERT INTO platform.operator_audit_event (operator_id, action, account_id, before, after, request_id)
  VALUES (NULL, 'SUPPORT_ACCESS_END', v_firm, jsonb_build_object('endsAt', g.ends_at),
    jsonb_build_object('grantId', g.id, 'level', g.level, 'endedAt', g.ends_at, 'source', 'expiry'), v_request);
  RETURN true;
END
$$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO canopy_platform;--> statement-breakpoint
ALTER FUNCTION app_record_support_expiry(uuid, timestamptz) OWNER TO canopy_platform;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM canopy_platform;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_record_support_expiry(uuid, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_record_support_expiry(uuid, timestamptz) TO canopy_app;
