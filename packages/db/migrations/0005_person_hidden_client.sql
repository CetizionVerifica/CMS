-- Re-audit of PR #16, finding A: a client context must not change a person who also works for a client
-- it cannot see (one person can belong to several clients, e.g. after the importer's name de-dupe).
-- The person update policy (migration 0006) calls this function. Custom migration: Drizzle Kit does
-- not model SQL functions.

-- Whether a person has an active membership, assignment or instance in a client outside the caller's
-- app.client_ids. Those rows are hidden from the caller, so this definer function reads them as a
-- firm-wide context of the same firm and answers yes/no only. app.client_ids is still the caller's
-- (only app.all_clients is overridden); the policy skips this check for all-client contexts.
CREATE FUNCTION app_person_in_hidden_client(target uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
SET app.all_clients = 'on'
AS $$
DECLARE
  visible uuid[] := app_client_ids();
BEGIN
  RETURN EXISTS (
      SELECT 1 FROM membership m
      WHERE m.firm_id = app_firm_id() AND m.person_id = target AND m.client_id IS NOT NULL
        AND m.archived_at IS NULL AND NOT (m.client_id = ANY (visible)))
    OR EXISTS (
      SELECT 1 FROM assignment a
      WHERE a.firm_id = app_firm_id() AND (a.default_owner_id = target OR a.default_approver_id = target)
        AND a.archived_at IS NULL AND NOT (a.client_id = ANY (visible)))
    OR EXISTS (
      SELECT 1 FROM compliance_instance i
      WHERE i.firm_id = app_firm_id() AND (i.owner_id = target OR i.approver_id = target)
        AND i.archived_at IS NULL AND NOT (i.client_id = ANY (visible)));
END
$$;
