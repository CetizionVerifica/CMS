-- Audit follow-ups for the send log (#224) and the support-expiry trail (#226), one migration.
--
-- 1. The send log's client check names the account kind (#224 audit, Info). A send without a client names no
--    instance, and either answers an event or is about the whole account (TRIAL_ENDING), as the repository already
--    holds. The kind is compared as text: a fresh database applies 0027's ADD VALUE and this migration in one
--    transaction, where the new enum value itself cannot be used yet, while its label as text can.
ALTER TABLE "notification_send" DROP CONSTRAINT "notification_send_client_check";--> statement-breakpoint
ALTER TABLE "notification_send" ADD CONSTRAINT "notification_send_client_check" CHECK (client_id is not null or (instance_id is null and (event_id is not null or kind::text = 'TRIAL_ENDING')));--> statement-breakpoint
-- 2. A support grant ends once in the operator trail, by revoke (0024) or by expiry. The unique index makes it so in
--    the database: two closeExpired runs at once (#226 audit, Low) no longer both write an END, since the second
--    insert waits on the first and then does nothing. Revokes are final (0024) and the expiry function never had a
--    caller before this, so no grant has two ENDs yet.
CREATE UNIQUE INDEX "operator_audit_event_support_end_key" ON "platform"."operator_audit_event" USING btree ((after->>'grantId')) WHERE action = 'SUPPORT_ACCESS_END';--> statement-breakpoint
-- 3. app_record_support_expiry (0029) after its audit (#226):
--    - it trusted p_now, so a caller could end a live grant in the trail (Low): a grant counts as run out only by
--      least(p_now, now());
--    - a grant whose support person holds no membership (READ_ONLY on an account with no clients) never got its END
--      (Info): it no longer asks for a live membership, and records each grant once through the index above, with
--      ON CONFLICT DO NOTHING, with no conflict target, since a target needs SELECT on the trail and canopy_platform
--      may only INSERT into it (the row's own id is new, so the index above is the only key it can meet);
--      closeExpired calls it for every grant that ran out.
--    CREATE OR REPLACE keeps its owner (canopy_platform) and its grants (EXECUTE to canopy_app only).
CREATE OR REPLACE FUNCTION app_record_support_expiry(p_grant uuid, p_now timestamptz)
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
    WHERE id = p_grant AND firm_id = v_firm AND revoked_at IS NULL AND ends_at <= least(p_now, now());
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO platform.operator_audit_event (operator_id, action, account_id, before, after, request_id)
  VALUES (NULL, 'SUPPORT_ACCESS_END', v_firm, jsonb_build_object('endsAt', g.ends_at),
    jsonb_build_object('grantId', g.id, 'level', g.level, 'endedAt', g.ends_at, 'source', 'expiry'), v_request)
  ON CONFLICT DO NOTHING;
  RETURN FOUND;
END
$$;
--> statement-breakpoint
-- 4. The revoke trigger (0024) meets the same index: a grant whose expiry is already in the trail can still be revoked
--    when the caller's clock runs behind the database's (revoke compares ends_at with the caller's now), and that
--    revoke must not fail on the index. Its END is skipped, since the grant had already ended; only that INSERT changes.
CREATE OR REPLACE FUNCTION canopy_audit_support_grant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_request text := coalesce(nullif(current_setting('app.request_id', true), ''), 'support-grant');
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO platform.operator_audit_event (operator_id, action, account_id, before, after, request_id)
    VALUES (NULL, 'SUPPORT_ACCESS_START', NEW.firm_id, NULL,
      jsonb_build_object('grantId', NEW.id, 'level', NEW.level, 'startsAt', NEW.starts_at, 'endsAt', NEW.ends_at,
        'source', 'grant'),
      v_request);
  ELSIF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    INSERT INTO platform.operator_audit_event (operator_id, action, account_id, before, after, request_id)
    VALUES (NULL, 'SUPPORT_ACCESS_END', NEW.firm_id, jsonb_build_object('endsAt', NEW.ends_at),
      jsonb_build_object('grantId', NEW.id, 'level', NEW.level, 'revokedAt', NEW.revoked_at, 'source', 'grant'),
      v_request)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END
$$;
