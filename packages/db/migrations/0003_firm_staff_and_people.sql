-- Audit of PR #16, finding 1: firm-wide rows are changed by firm staff only, and client contexts see
-- only the people of their clients. Functions the new policies (migration 0004) call.
-- Custom migration: Drizzle Kit does not model SQL functions.

-- True for contexts of firm staff (firm admins, consultants) and system jobs: they may change firm-wide
-- rows (firm settings, library) and see every person of the firm.
CREATE FUNCTION app_firm_staff() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT coalesce(current_setting('app.firm_staff', true) = 'on', false) $$;
--> statement-breakpoint

-- Whether a client context may see a person: someone with a membership, assignment or instance in a
-- client the context sees. Runs as the caller, so those tables' own policies do the client filtering.
-- plpgsql so the body may name tables created by a later migration.
CREATE FUNCTION app_person_visible(target uuid) RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN EXISTS (
      SELECT 1 FROM membership m
      WHERE m.person_id = target AND m.client_id IS NOT NULL AND m.archived_at IS NULL
        AND app_can_see_client(m.client_id))
    OR EXISTS (
      SELECT 1 FROM assignment a
      WHERE (a.default_owner_id = target OR a.default_approver_id = target) AND a.archived_at IS NULL)
    OR EXISTS (
      SELECT 1 FROM compliance_instance i
      WHERE (i.owner_id = target OR i.approver_id = target) AND i.archived_at IS NULL);
END
$$;
--> statement-breakpoint

-- Whether a person holds a firm role (FIRM_ADMIN, CONSULTANT) in the current firm. Those memberships
-- have no client, so client contexts cannot see them; this definer function answers yes/no only,
-- reading as a firm-wide context of the same firm.
CREATE FUNCTION app_person_has_firm_role(target uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
SET app.all_clients = 'on'
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM membership m
    WHERE m.firm_id = app_firm_id() AND m.person_id = target
      AND m.role IN ('FIRM_ADMIN', 'CONSULTANT') AND m.archived_at IS NULL);
END
$$;
