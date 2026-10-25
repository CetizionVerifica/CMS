-- ISO add-on (ADR M16-0001): the console's add-on switch can take a plan feature away from one account
-- (account_override.removed_features), acts are STATUTE or STANDARD, and obligations under a STANDARD act name the
-- clauses they serve as { standard, clauseNumber } objects. Existing rows get STATUTE, no clauses and nothing removed.

CREATE TYPE "public"."act_kind" AS ENUM('STATUTE', 'STANDARD');--> statement-breakpoint
ALTER TABLE "act" ADD COLUMN "kind" "act_kind" DEFAULT 'STATUTE' NOT NULL;--> statement-breakpoint
ALTER TABLE "obligation" ADD COLUMN "clause_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."account_override" ADD COLUMN "removed_features" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "act" ADD CONSTRAINT "act_standard_central_check" CHECK (kind <> 'STANDARD' or jurisdiction = 'CENTRAL');--> statement-breakpoint
ALTER TABLE "obligation" ADD CONSTRAINT "obligation_clause_refs_check" CHECK (jsonb_typeof(clause_refs) = 'array' and jsonb_array_length(clause_refs) <= 20 and not jsonb_path_exists(clause_refs, '$[*] ? (@.type() != "object" || !exists(@.standard) || !exists(@.clauseNumber) || exists(@.keyvalue() ? (@.key != "standard" && @.key != "clauseNumber")) || !(@.standard == "ISO_9001" || @.standard == "ISO_14001" || @.standard == "ISO_45001") || @.clauseNumber.type() != "string" || !(@.clauseNumber like_regex "^[1-9][0-9]?([.](0|[1-9][0-9]?)){0,3}$"))'));--> statement-breakpoint
ALTER TABLE "platform"."account_override" ADD CONSTRAINT "account_override_features_check" CHECK (not (features && removed_features));--> statement-breakpoint

-- The account's effective features are (plan ∪ override features) − override removed features, as contracts'
-- effectiveFeatures and platformAccounts.entitlements compute them. CREATE OR REPLACE keeps the owner (canopy_platform)
-- and the grants (EXECUTE to canopy_app only) that 0020 gave it.
CREATE OR REPLACE FUNCTION app_account()
RETURNS TABLE (kind account_kind, status account_status, plan_code text, trial_ends_on date, limits jsonb, features text[])
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT f.kind, f.status, f.plan_code, f.trial_ends_on,
    p.limits || coalesce(o.limits, '{}'::jsonb),
    ARRAY(
      SELECT DISTINCT flag FROM unnest(p.features || coalesce(o.features, '{}'::text[])) AS flag
      WHERE flag <> ALL (coalesce(o.removed_features, '{}'::text[]))
      ORDER BY 1)
  FROM firm f
  JOIN platform.plan p ON p.code = f.plan_code
  LEFT JOIN platform.account_override o ON o.account_id = f.id
  WHERE f.id = app_firm_id()
$$;
