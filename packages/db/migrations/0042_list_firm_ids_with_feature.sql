-- ISO add-on, ISO-2f (docs/iso/plan.md §4.5-4.6): the jobs' second cross-tenant read. Like canopy_list_firm_ids()
-- (0007), it returns ids and nothing else (ADR 0003), here of the TRIAL and ACTIVE accounts whose effective features
-- (canopy_effective_features, 0039) include the flag, so a job for one add-on reads only the accounts that have it
-- (#277 audit Info 2). Custom migration: no table changes.
--
-- Owned by canopy_lookup, the one owner whose policy (lookup_read on firm) sees every firm; canopy_platform reads the
-- plan and override tables but sees only the firm in app_firm_id(). canopy_lookup already reads firm.id and
-- firm.status (0007, 0020); it gets only the further columns the function joins on or reads, never a whole row, and
-- the platform schema's USAGE for the two tables. The platform tables have no RLS, so no policy is needed.
GRANT SELECT ("plan_code") ON "firm" TO canopy_lookup;--> statement-breakpoint
GRANT USAGE ON SCHEMA platform TO canopy_lookup;--> statement-breakpoint
GRANT SELECT ("code", "features") ON "platform"."plan" TO canopy_lookup;--> statement-breakpoint
GRANT SELECT ("account_id", "features", "removed_features") ON "platform"."account_override" TO canopy_lookup;--> statement-breakpoint
CREATE FUNCTION canopy_list_firm_ids_with_feature(p_flag text) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT f.id FROM firm f
  JOIN platform.plan p ON p.code = f.plan_code
  LEFT JOIN platform.account_override o ON o.account_id = f.id
  WHERE f.status IN ('TRIAL', 'ACTIVE')
    AND p_flag = ANY (public.canopy_effective_features(p.features, o.features, o.removed_features))
  ORDER BY f.id
$$;
--> statement-breakpoint
-- A new owner needs CREATE on the schema at the moment of the change only (as in 0007).
GRANT CREATE ON SCHEMA public TO canopy_lookup;--> statement-breakpoint
ALTER FUNCTION canopy_list_firm_ids_with_feature(text) OWNER TO canopy_lookup;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM canopy_lookup;--> statement-breakpoint
REVOKE ALL ON FUNCTION canopy_list_firm_ids_with_feature(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION canopy_list_firm_ids_with_feature(text) TO canopy_app;
