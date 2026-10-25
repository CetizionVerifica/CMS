-- Audit of #253 (Medium): the jsonpath CHECK on obligation.clause_refs ran in lax mode, which unwraps nested arrays
-- and array-valued keys, so [[{...}]] and { "standard": ["ISO_9001"], ... } got through. The check is now a plain SQL
-- function over jsonb_array_elements, with CASE guards so no branch errors on a non-array or non-object value, and it
-- also refuses a repeated { standard, clauseNumber } pair (audit Info). Existing rows are all '[]' (repositories
-- refuse non-empty writes until ISO-1), so the new constraint validates at once.
CREATE FUNCTION canopy_clause_refs_valid(refs jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN jsonb_typeof(refs) <> 'array' THEN false
    WHEN jsonb_array_length(refs) > 20 THEN false
    ELSE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(refs) AS e
      WHERE CASE
        WHEN jsonb_typeof(e) <> 'object' THEN true
        WHEN (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e) AS k) IS DISTINCT FROM ARRAY['clauseNumber', 'standard'] THEN true
        WHEN jsonb_typeof(e -> 'standard') IS DISTINCT FROM 'string' OR jsonb_typeof(e -> 'clauseNumber') IS DISTINCT FROM 'string' THEN true
        WHEN (e ->> 'standard') NOT IN ('ISO_9001', 'ISO_14001', 'ISO_45001') THEN true
        ELSE (e ->> 'clauseNumber') !~ '^[1-9][0-9]?(\.(0|[1-9][0-9]?)){0,3}$'
      END)
      AND (SELECT count(*) = count(DISTINCT e) FROM jsonb_array_elements(refs) AS e)
  END
$$;
--> statement-breakpoint
ALTER TABLE "obligation" DROP CONSTRAINT "obligation_clause_refs_check";--> statement-breakpoint
ALTER TABLE "obligation" ADD CONSTRAINT "obligation_clause_refs_check" CHECK (canopy_clause_refs_valid(clause_refs));