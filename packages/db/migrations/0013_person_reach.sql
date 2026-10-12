-- For M6: which clients of the current firm a person works in, and whether they are firm staff, so the entity
-- store can decide who may see or change them without reading rows the caller cannot see. Ids and a flag only,
-- never names. Same pattern as app_person_in_hidden_client (0005): a definer that reads as a firm-wide context
-- of the caller's firm only. Custom migration: Drizzle Kit does not model SQL functions.
--
-- client_ids: clients with a live (non-archived, unexpired) membership, a consultant's assigned clients, or a
-- non-archived assignment (default owner or approver) or instance (owner or approver) of the person.
CREATE FUNCTION app_person_reach(target uuid, OUT client_ids uuid[], OUT firm_staff boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
SET app.all_clients = 'on'
AS $$
BEGIN
  SELECT coalesce(array_agg(DISTINCT c ORDER BY c), '{}'::uuid[]) INTO client_ids FROM (
    SELECT m.client_id AS c FROM membership m
    WHERE m.firm_id = app_firm_id() AND m.person_id = target AND m.client_id IS NOT NULL
      AND m.archived_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now())
    UNION
    SELECT unnest(m.consultant_client_ids) FROM membership m
    WHERE m.firm_id = app_firm_id() AND m.person_id = target AND m.role = 'CONSULTANT'
      AND m.archived_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now())
    UNION
    SELECT a.client_id FROM assignment a
    WHERE a.firm_id = app_firm_id() AND (a.default_owner_id = target OR a.default_approver_id = target)
      AND a.archived_at IS NULL
    UNION
    SELECT i.client_id FROM compliance_instance i
    WHERE i.firm_id = app_firm_id() AND (i.owner_id = target OR i.approver_id = target)
      AND i.archived_at IS NULL
  ) reach
  -- A consultant's list may name an archived client; keep only clients that exist in this firm.
  WHERE c IN (SELECT cl.id FROM client cl WHERE cl.firm_id = app_firm_id());
  firm_staff := EXISTS (
    SELECT 1 FROM membership m
    WHERE m.firm_id = app_firm_id() AND m.person_id = target AND m.role IN ('FIRM_ADMIN', 'CONSULTANT')
      AND m.archived_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now()));
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_person_reach(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_person_reach(uuid) TO canopy_app;
