-- ISO add-on, ISO-2c (docs/iso/plan.md §4.2-4.4, catalogue.md §2): library guards, the ISO catalogue marker and one
-- feature formula.
--
-- act.kind cannot be used to get round the add-on switch: only the system job (M6's catalogue copy) may insert a
-- STANDARD act (restrictive policy standard_insert), and a trigger refuses any change of kind, whatever the role. Act
-- names are unique per firm and kind among non-archived rows, so a STATUTE and a STANDARD act may share a name. No
-- STANDARD act exists before this migration (nothing could insert one), so the rebuilt index cannot fail.

DROP INDEX "act_name_key";--> statement-breakpoint
ALTER TABLE "firm" ADD COLUMN "iso_catalogue_copied_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "act_name_key" ON "act" USING btree ("firm_id","kind","name") WHERE archived_at is null;--> statement-breakpoint
CREATE POLICY "standard_insert" ON "act" AS RESTRICTIVE FOR INSERT TO public WITH CHECK (firm_id = app_firm_id() and (kind <> 'STANDARD' or app_system_job()));--> statement-breakpoint
CREATE FUNCTION canopy_act_kind_fixed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'act.kind is set when the act is created and never changes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "act_kind_fixed" BEFORE UPDATE OF "kind" ON "act" FOR EACH ROW EXECUTE FUNCTION canopy_act_kind_fixed();--> statement-breakpoint

-- The account's effective features, (plan ∪ added) − removed, sorted and distinct: contracts' effectiveFeatures in
-- SQL, the one place both reads (app_account() and platformAccounts.entitlements) compute it. Pure: reads no table,
-- so any role may call it. A null list counts as empty.
CREATE FUNCTION canopy_effective_features(plan text[], added text[], removed text[]) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT ARRAY(
    SELECT DISTINCT flag FROM unnest(coalesce(plan, '{}'::text[]) || coalesce(added, '{}'::text[])) AS flag
    WHERE flag IS NOT NULL AND flag <> ALL (coalesce(removed, '{}'::text[]))
    ORDER BY 1)
$$;
--> statement-breakpoint

-- Same result columns as 0036, so CREATE OR REPLACE keeps the owner (canopy_platform) and 0020's grants (EXECUTE to
-- canopy_app only).
CREATE OR REPLACE FUNCTION app_account()
RETURNS TABLE (kind account_kind, status account_status, plan_code text, trial_ends_on date, limits jsonb, features text[])
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT f.kind, f.status, f.plan_code, f.trial_ends_on,
    p.limits || coalesce(o.limits, '{}'::jsonb),
    public.canopy_effective_features(p.features, o.features, o.removed_features)
  FROM firm f
  JOIN platform.plan p ON p.code = f.plan_code
  LEFT JOIN platform.account_override o ON o.account_id = f.id
  WHERE f.id = app_firm_id()
$$;
--> statement-breakpoint

-- The ISO catalogue marker (plan §4.3). M6's copier calls it first, in the account's own system context and in the
-- copy's transaction: it sets firm.iso_catalogue_copied_at once and returns true when it set it, so a concurrent second
-- copy waits on the row, gets false and copies nothing, and a failed copy rolls the marker back. It works in TRIAL and
-- ACTIVE (unlike app_mark_library_copied, which needs PROVISIONING); any other status gets false. SECURITY DEFINER
-- because the app role cannot update the column; search_path pinned, owned by canopy_platform, EXECUTE to canopy_app
-- only (audit of #260).
CREATE FUNCTION app_mark_iso_catalogue_copied()
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF app_firm_id() IS NULL OR NOT app_system_job() THEN
    RAISE EXCEPTION 'app_mark_iso_catalogue_copied needs the account''s system context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE firm SET iso_catalogue_copied_at = now()
    WHERE id = app_firm_id() AND status IN ('TRIAL', 'ACTIVE') AND iso_catalogue_copied_at IS NULL;
  RETURN FOUND;
END
$$;
--> statement-breakpoint
GRANT UPDATE ("iso_catalogue_copied_at") ON "firm" TO canopy_platform;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO canopy_platform;--> statement-breakpoint
ALTER FUNCTION app_mark_iso_catalogue_copied() OWNER TO canopy_platform;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM canopy_platform;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_mark_iso_catalogue_copied() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_mark_iso_catalogue_copied() TO canopy_app;
