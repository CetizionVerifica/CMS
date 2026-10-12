-- Sign-in storage for M5 (ADR M3-0001): forced RLS, grants and triggers for the auth tables of 0011, and the
-- three lookups that run before a tenant is known. Custom migration: Drizzle Kit does not model these.

ALTER TABLE "auth_credential" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "auth_session" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "auth_invite" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "auth_token" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- No deletes: sessions and tokens end by revoked_at / used_at, invites by accepted_at / revoked_at.
GRANT SELECT, INSERT, UPDATE ON "auth_credential" TO canopy_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "auth_session" TO canopy_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "auth_invite" TO canopy_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "auth_token" TO canopy_app;--> statement-breakpoint

CREATE TRIGGER "auth_credential_touch_updated_at" BEFORE UPDATE ON "auth_credential" FOR EACH ROW EXECUTE FUNCTION canopy_touch_updated_at();--> statement-breakpoint

-- canopy_lookup (migration 0007) reads only the columns the lookups return or filter on. Never the MFA secret.
GRANT SELECT ("name", "archived_at") ON "firm" TO canopy_lookup;--> statement-breakpoint
GRANT SELECT ("id", "firm_id", "email", "status", "archived_at") ON "person" TO canopy_lookup;--> statement-breakpoint
GRANT SELECT ("firm_id", "person_id", "password_hash", "locked_until") ON "auth_credential" TO canopy_lookup;--> statement-breakpoint
GRANT SELECT ("id", "firm_id", "person_id", "token_hash", "csrf_token", "mfa_satisfied", "expires_at", "revoked_at") ON "auth_session" TO canopy_lookup;--> statement-breakpoint
GRANT SELECT ("id", "firm_id", "person_id", "kind", "invite_id", "token_hash", "expires_at", "used_at") ON "auth_token" TO canopy_lookup;--> statement-breakpoint
GRANT SELECT ("id", "firm_id", "expires_at", "accepted_at", "revoked_at") ON "auth_invite" TO canopy_lookup;--> statement-breakpoint

-- People who may sign in with this email, across firms: ACTIVE, INVITED and DISABLED (M5 answers each), never
-- UNCLAIMED or archived people, nor archived firms.
CREATE FUNCTION canopy_login_candidates(p_email text)
RETURNS TABLE (firm_id uuid, person_id uuid, firm_name text, status person_status, password_hash text, locked_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.firm_id, p.id, f.name, p.status, c.password_hash, c.locked_until
  FROM person p
  JOIN firm f ON f.id = p.firm_id
  LEFT JOIN auth_credential c ON c.firm_id = p.firm_id AND c.person_id = p.id
  WHERE p.email IS NOT NULL AND lower(p.email) = lower(p_email)
    AND p.archived_at IS NULL AND p.status <> 'UNCLAIMED' AND f.archived_at IS NULL
  ORDER BY f.name, p.firm_id
$$;
--> statement-breakpoint
-- A session that has not been revoked, by the SHA-256 of its cookie token. Expiry is checked by the caller.
CREATE FUNCTION canopy_find_session(p_token_hash text)
RETURNS TABLE (id uuid, firm_id uuid, person_id uuid, csrf_token text, mfa_satisfied boolean, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.id, s.firm_id, s.person_id, s.csrf_token, s.mfa_satisfied, s.expires_at
  FROM auth_session s
  WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL
$$;
--> statement-breakpoint
-- A sign-in link by the SHA-256 of its token, with whether its invite is still open. Used and expired tokens
-- are returned so the caller can answer them; it checks used_at and expires_at.
CREATE FUNCTION canopy_find_login_token(p_token_hash text)
RETURNS TABLE (id uuid, firm_id uuid, person_id uuid, kind text, invite_id uuid, token_hash text, expires_at timestamptz, used_at timestamptz, invite_open boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.firm_id, t.person_id, t.kind, t.invite_id, t.token_hash, t.expires_at, t.used_at,
    coalesce(i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now(), false)
  FROM auth_token t
  LEFT JOIN auth_invite i ON i.firm_id = t.firm_id AND i.id = t.invite_id
  WHERE t.token_hash = p_token_hash
$$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO canopy_lookup;--> statement-breakpoint
ALTER FUNCTION canopy_login_candidates(text) OWNER TO canopy_lookup;--> statement-breakpoint
ALTER FUNCTION canopy_find_session(text) OWNER TO canopy_lookup;--> statement-breakpoint
ALTER FUNCTION canopy_find_login_token(text) OWNER TO canopy_lookup;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM canopy_lookup;--> statement-breakpoint
REVOKE ALL ON FUNCTION canopy_login_candidates(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION canopy_find_session(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION canopy_find_login_token(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION canopy_login_candidates(text) TO canopy_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION canopy_find_session(text) TO canopy_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION canopy_find_login_token(text) TO canopy_app;
