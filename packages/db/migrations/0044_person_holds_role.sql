-- ISO add-on, ISO-2i (docs/iso/model.md §1 rule 5; ADR M16-0004 decision 6): does a person hold one of some roles in a
-- client, covering a unit when one is given? M16 checks every person an ISO record names this way. A client role cannot
-- read a firm admin's or consultant's membership (the membership policy), so the answer comes from a SECURITY DEFINER
-- read that returns a boolean and no rows. Generated for the policy; the function and grants are hand-written.
--
-- Owned by canopy_lookup, as 0042: it gets a SELECT policy on membership limited to the request's firm
-- (app_firm_id(), never a parameter) and only the membership columns the function reads. The client and unit it reads
-- through their own tenant policies, so a client the caller may not see, or a unit outside that client, answers false
-- and the function cannot probe other clients.
CREATE POLICY "role_lookup" ON "membership" AS PERMISSIVE FOR SELECT TO "canopy_lookup" USING (firm_id = app_firm_id());--> statement-breakpoint
GRANT SELECT ("firm_id", "person_id", "role", "client_id", "consultant_client_ids", "unit_ids", "archived_at", "expires_at") ON "membership" TO canopy_lookup;--> statement-breakpoint
GRANT SELECT ("id") ON "client" TO canopy_lookup;--> statement-breakpoint
GRANT SELECT ("id", "client_id") ON "unit" TO canopy_lookup;--> statement-breakpoint
-- A live membership (not archived, not expired) in the request's firm that is firm-wide (FIRM_ADMIN), names the client
-- (CONSULTANT through its client list, a client role through client_id), and lists no units or lists the unit.
CREATE FUNCTION canopy_person_holds_role(p_person uuid, p_roles "role"[], p_client uuid, p_unit uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(
    app_can_see_client(p_client)
    AND EXISTS (SELECT 1 FROM client c WHERE c.id = p_client)
    AND (p_unit IS NULL OR EXISTS (SELECT 1 FROM unit u WHERE u.id = p_unit AND u.client_id = p_client))
    AND EXISTS (
      SELECT 1 FROM membership m
      WHERE m.firm_id = app_firm_id() AND m.person_id = p_person AND m.role = ANY (p_roles)
        AND m.archived_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now())
        AND (m.role = 'FIRM_ADMIN' OR m.client_id = p_client
             OR (m.role = 'CONSULTANT' AND p_client = ANY (m.consultant_client_ids)))
        AND (p_unit IS NULL OR m.unit_ids IS NULL OR p_unit = ANY (m.unit_ids))),
    false)
$$;
--> statement-breakpoint
-- A new owner needs CREATE on the schema at the moment of the change only (as in 0007 and 0042).
GRANT CREATE ON SCHEMA public TO canopy_lookup;--> statement-breakpoint
ALTER FUNCTION canopy_person_holds_role(uuid, "role"[], uuid, uuid) OWNER TO canopy_lookup;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM canopy_lookup;--> statement-breakpoint
REVOKE ALL ON FUNCTION canopy_person_holds_role(uuid, "role"[], uuid, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION canopy_person_holds_role(uuid, "role"[], uuid, uuid) TO canopy_app;
