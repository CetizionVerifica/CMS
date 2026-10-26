-- ISO add-on, ISO-2j: canopy_person_holds_role (0044) also needs the person to be live, neither archived nor DISABLED.
-- A client role cannot read a firm admin's or consultant's person row, so M16's own person check cannot see that either;
-- the lookup answers it. canopy_lookup already reads person.id, firm_id, status and archived_at (0012, lookup_read), so no
-- grant changes. CREATE OR REPLACE keeps the owner (canopy_lookup) and the EXECUTE grants. Custom migration.
CREATE OR REPLACE FUNCTION canopy_person_holds_role(p_person uuid, p_roles "role"[], p_client uuid, p_unit uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(
    app_can_see_client(p_client)
    AND EXISTS (SELECT 1 FROM client c WHERE c.id = p_client)
    AND (p_unit IS NULL OR EXISTS (SELECT 1 FROM unit u WHERE u.id = p_unit AND u.client_id = p_client))
    AND EXISTS (
      SELECT 1 FROM person p
      WHERE p.firm_id = app_firm_id() AND p.id = p_person AND p.archived_at IS NULL AND p.status <> 'DISABLED')
    AND EXISTS (
      SELECT 1 FROM membership m
      WHERE m.firm_id = app_firm_id() AND m.person_id = p_person AND m.role = ANY (p_roles)
        AND m.archived_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now())
        AND (m.role = 'FIRM_ADMIN' OR m.client_id = p_client
             OR (m.role = 'CONSULTANT' AND p_client = ANY (m.consultant_client_ids)))
        AND (p_unit IS NULL OR m.unit_ids IS NULL OR p_unit = ANY (m.unit_ids))),
    false)
$$;
