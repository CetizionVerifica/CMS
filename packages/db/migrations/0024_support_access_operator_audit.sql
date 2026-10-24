-- Support access in the operator audit (ADR M15-0001 decision 11, ADR M15-0004): when an account admin grants or
-- revokes PlanetPulse support access, the operator trail gets SUPPORT_ACCESS_START or SUPPORT_ACCESS_END in the same
-- transaction. The customer's request runs as canopy_app, which cannot write platform.operator_audit_event, so a
-- trigger owned by canopy_platform writes it (as canopy_activate_account does in 0023). Custom migration: Drizzle Kit
-- does not model functions, triggers or grants. The entries carry ids, the level and times only, never a person.
CREATE FUNCTION canopy_audit_support_grant() RETURNS trigger
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
      v_request);
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO canopy_platform;--> statement-breakpoint
ALTER FUNCTION canopy_audit_support_grant() OWNER TO canopy_platform;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM canopy_platform;--> statement-breakpoint
REVOKE ALL ON FUNCTION canopy_audit_support_grant() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "support_grant_operator_audit_insert" AFTER INSERT ON "support_grant"
  FOR EACH ROW EXECUTE FUNCTION canopy_audit_support_grant();--> statement-breakpoint
CREATE TRIGGER "support_grant_operator_audit_revoke" AFTER UPDATE OF "revoked_at" ON "support_grant"
  FOR EACH ROW EXECUTE FUNCTION canopy_audit_support_grant();
--> statement-breakpoint
-- A revoke is final (audit of #184, Low): once revoked_at is set, neither it nor revoked_by_id may change, so no
-- tenant write can revive a revoked grant or rewrite who revoked it.
CREATE FUNCTION canopy_support_grant_revoke_final() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
      OR NEW.revoked_by_id IS DISTINCT FROM OLD.revoked_by_id) THEN
    RAISE EXCEPTION 'support grant % is already revoked', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "support_grant_revoke_final" BEFORE UPDATE OF "revoked_at", "revoked_by_id" ON "support_grant"
  FOR EACH ROW EXECUTE FUNCTION canopy_support_grant_revoke_final();
