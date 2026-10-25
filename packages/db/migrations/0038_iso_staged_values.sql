-- ISO add-on, ISO-2b (docs/iso/model.md §7-9, plan §5.1): the database stores contracts 1.8.0's staged ISO entity
-- types, reminder kinds and export kinds before they join the contract enums (ISO-1b), as 0019 and 0027 did for
-- theirs. Nothing writes them before the ISO API (M16).
--
-- The send log gets an ISO subject (type and id) for scheduled ISO reminders, never with an instance, keyed per
-- subject, kind, date and recipient, so two ISO records due the same day for one person are two sends; the digest
-- key leaves ISO rows out. The new check compares kinds as text (as 0030 and 0034 do), so the new enum values and the
-- check apply in one run.
--
-- Every firm stored before contracts 1.8.0 gets the default ISO risk rule in its settings (DEFAULT_ISO_RISK_RULE), so
-- a raw read of firm.settings carries isoRisk as the FirmSettings type says (audit of #265, Low 3).

ALTER TYPE "public"."entity_type" ADD VALUE 'management_system';--> statement-breakpoint
ALTER TYPE "public"."entity_type" ADD VALUE 'certification';--> statement-breakpoint
ALTER TYPE "public"."entity_type" ADD VALUE 'external_audit';--> statement-breakpoint
ALTER TYPE "public"."entity_type" ADD VALUE 'context_item';--> statement-breakpoint
ALTER TYPE "public"."entity_type" ADD VALUE 'clause_assessment';--> statement-breakpoint
ALTER TYPE "public"."entity_type" ADD VALUE 'controlled_document';--> statement-breakpoint
ALTER TYPE "public"."entity_type" ADD VALUE 'document_revision';--> statement-breakpoint
ALTER TYPE "public"."entity_type" ADD VALUE 'risk_item';--> statement-breakpoint
ALTER TYPE "public"."entity_type" ADD VALUE 'risk_control';--> statement-breakpoint
ALTER TYPE "public"."entity_type" ADD VALUE 'objective';--> statement-breakpoint
ALTER TYPE "public"."entity_type" ADD VALUE 'objective_reading';--> statement-breakpoint
ALTER TYPE "public"."entity_type" ADD VALUE 'audit_programme';--> statement-breakpoint
ALTER TYPE "public"."entity_type" ADD VALUE 'internal_audit';--> statement-breakpoint
ALTER TYPE "public"."entity_type" ADD VALUE 'audit_checklist_item';--> statement-breakpoint
ALTER TYPE "public"."entity_type" ADD VALUE 'audit_finding';--> statement-breakpoint
ALTER TYPE "public"."entity_type" ADD VALUE 'nonconformity';--> statement-breakpoint
ALTER TYPE "public"."entity_type" ADD VALUE 'iso_action';--> statement-breakpoint
ALTER TYPE "public"."entity_type" ADD VALUE 'management_review';--> statement-breakpoint
ALTER TYPE "public"."export_kind" ADD VALUE 'ISO_NC_LOG_XLSX';--> statement-breakpoint
ALTER TYPE "public"."export_kind" ADD VALUE 'ISO_RISK_REGISTER_XLSX';--> statement-breakpoint
ALTER TYPE "public"."export_kind" ADD VALUE 'ISO_AUDIT_REPORT_PDF';--> statement-breakpoint
ALTER TYPE "public"."export_kind" ADD VALUE 'ISO_REVIEW_PACK_PDF';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'ISO_ACTION_DUE';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'ISO_ACTION_OVERDUE';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'ISO_REVIEW_DUE';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'ISO_AUDIT_STARTING';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'ISO_CERTIFICATE_EXPIRING';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'ISO_SURVEILLANCE_DUE';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'ISO_EXTERNAL_RESPONSE_DUE';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'ISO_MANAGEMENT_REVIEW_DUE';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'ISO_EFFECTIVENESS_DUE';--> statement-breakpoint
DROP INDEX "notification_send_digest_key";--> statement-breakpoint
ALTER TABLE "notification_send" ADD COLUMN "iso_subject_type" "entity_type";--> statement-breakpoint
ALTER TABLE "notification_send" ADD COLUMN "iso_subject_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_send_iso_subject_key" ON "notification_send" USING btree ("firm_id","iso_subject_type","iso_subject_id","kind","send_date","recipient_id") WHERE iso_subject_id is not null and event_id is null;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_send_digest_key" ON "notification_send" USING btree ("recipient_id","kind","send_date") WHERE instance_id is null and event_id is null and iso_subject_id is null;--> statement-breakpoint
ALTER TABLE "notification_send" ADD CONSTRAINT "notification_send_iso_subject_check" CHECK ((iso_subject_type is null) = (iso_subject_id is null) and (iso_subject_id is not null) = starts_with(kind::text, 'ISO_') and (iso_subject_id is null or (instance_id is null and event_id is null and client_id is not null)));--> statement-breakpoint
-- FORCE RLS binds the owner, so each firm is updated as itself (as in 0019). A DELETED firm keeps its emptied settings.
DO $$
DECLARE f uuid;
BEGIN
  FOR f IN SELECT canopy_list_firm_ids() LOOP
    PERFORM set_config('app.firm_id', f::text, true), set_config('app.firm_staff', 'on', true);
    UPDATE "firm"
      SET "settings" = "settings" || '{"isoRisk": {"significantAt": 12, "legalLinkMakesSignificant": true}}'::jsonb
      WHERE "id" = f AND "status" <> 'DELETED' AND NOT ("settings" ? 'isoRisk');
  END LOOP;
  PERFORM set_config('app.firm_id', '', true), set_config('app.firm_staff', '', true);
END
$$;
