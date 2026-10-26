-- ISO-2g (docs/iso/model.md §1.7, §3.13; ADR M16-0003): a held review's figures are stored on its input rows, and the
-- review rows' keys hold among live rows only, so a replan that adds a standard back makes a new live row beside the
-- archived one (#280 audit Info 1). Existing rows keep null figures, which 1.8.2's ReviewInput reads as none stored.
ALTER TABLE "review_input" DROP CONSTRAINT "review_input_def_key";--> statement-breakpoint
ALTER TABLE "review_output" DROP CONSTRAINT "review_output_def_key";--> statement-breakpoint
ALTER TABLE "review_input" ADD COLUMN "source_figures" jsonb;--> statement-breakpoint
ALTER TABLE "review_input" ADD COLUMN "figures_stored_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_input" ADD COLUMN "figures_engine_version" text;--> statement-breakpoint
CREATE UNIQUE INDEX "review_input_def_key" ON "review_input" USING btree ("management_review_id","input_def_id") WHERE archived_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "review_output_def_key" ON "review_output" USING btree ("management_review_id","output_def_id") WHERE archived_at is null;--> statement-breakpoint
ALTER TABLE "review_input" ADD CONSTRAINT "review_input_figures_check" CHECK (num_nulls(source_figures, figures_stored_at, figures_engine_version) in (0, 3));--> statement-breakpoint
ALTER TABLE "review_input" ADD CONSTRAINT "review_input_figures_object_check" CHECK (source_figures is null or jsonb_typeof(source_figures) = 'object');--> statement-breakpoint
ALTER TABLE "review_input" ADD CONSTRAINT "review_input_engine_version_check" CHECK (figures_engine_version is null or length(figures_engine_version) between 1 and 40);--> statement-breakpoint
-- The figures are a record (model §1.7): one update may set the three columns from all null to all set; after that the
-- trigger refuses any change to them, to the definition, to the review and to archived_at, whatever the role. notes
-- stays editable. The account purge deletes rows and never updates them.
CREATE FUNCTION canopy_review_input_figures_fixed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.figures_stored_at IS NOT NULL AND (
    NEW.source_figures IS DISTINCT FROM OLD.source_figures
    OR NEW.figures_stored_at IS DISTINCT FROM OLD.figures_stored_at
    OR NEW.figures_engine_version IS DISTINCT FROM OLD.figures_engine_version
    OR NEW.input_def_id IS DISTINCT FROM OLD.input_def_id
    OR NEW.management_review_id IS DISTINCT FROM OLD.management_review_id
    OR NEW.archived_at IS DISTINCT FROM OLD.archived_at) THEN
    RAISE EXCEPTION 'review_input figures are stored once and never change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "review_input_figures_fixed" BEFORE UPDATE ON "review_input" FOR EACH ROW EXECUTE FUNCTION canopy_review_input_figures_fixed();
