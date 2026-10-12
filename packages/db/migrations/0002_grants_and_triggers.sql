-- RLS applies to table owners too, app-role grants and row triggers for the v1 tables.
-- Custom migration: Drizzle Kit does not model FORCE ROW LEVEL SECURITY, grants or triggers.
-- A tooling test (test/schema-rules.db.test.ts) fails if a table is missing from any of these lists.

-- FORCE: policies bind the table owner as well, so only a superuser or BYPASSRLS role sees across firms.
ALTER TABLE "firm" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "client" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "location" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "unit" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "department" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "person" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "membership" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "act" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "category" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "obligation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assignment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "compliance_instance" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "evidence" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "comment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mapping_template" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "import_batch" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "import_row" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "import_issue" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "domain_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "export_job" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notification_send" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- No hard deletes (packages/db/CLAUDE.md rule 6): the app role never gets DELETE or TRUNCATE.
-- Firms are created on the owner connection (createFirm); audit rows are insert-only.
GRANT SELECT, UPDATE ON "firm" TO canopy_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "client" TO canopy_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "location" TO canopy_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "company" TO canopy_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "unit" TO canopy_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "department" TO canopy_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "person" TO canopy_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "membership" TO canopy_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "act" TO canopy_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "category" TO canopy_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "obligation" TO canopy_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "assignment" TO canopy_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "compliance_instance" TO canopy_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "evidence" TO canopy_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "comment" TO canopy_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "audit_event" TO canopy_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "mapping_template" TO canopy_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "import_batch" TO canopy_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "import_row" TO canopy_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "import_issue" TO canopy_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "domain_event" TO canopy_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "export_job" TO canopy_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "notification_send" TO canopy_app;--> statement-breakpoint

-- updated_at follows every UPDATE.
CREATE TRIGGER "firm_touch_updated_at" BEFORE UPDATE ON "firm" FOR EACH ROW EXECUTE FUNCTION canopy_touch_updated_at();--> statement-breakpoint
CREATE TRIGGER "client_touch_updated_at" BEFORE UPDATE ON "client" FOR EACH ROW EXECUTE FUNCTION canopy_touch_updated_at();--> statement-breakpoint
CREATE TRIGGER "location_touch_updated_at" BEFORE UPDATE ON "location" FOR EACH ROW EXECUTE FUNCTION canopy_touch_updated_at();--> statement-breakpoint
CREATE TRIGGER "company_touch_updated_at" BEFORE UPDATE ON "company" FOR EACH ROW EXECUTE FUNCTION canopy_touch_updated_at();--> statement-breakpoint
CREATE TRIGGER "unit_touch_updated_at" BEFORE UPDATE ON "unit" FOR EACH ROW EXECUTE FUNCTION canopy_touch_updated_at();--> statement-breakpoint
CREATE TRIGGER "department_touch_updated_at" BEFORE UPDATE ON "department" FOR EACH ROW EXECUTE FUNCTION canopy_touch_updated_at();--> statement-breakpoint
CREATE TRIGGER "person_touch_updated_at" BEFORE UPDATE ON "person" FOR EACH ROW EXECUTE FUNCTION canopy_touch_updated_at();--> statement-breakpoint
CREATE TRIGGER "membership_touch_updated_at" BEFORE UPDATE ON "membership" FOR EACH ROW EXECUTE FUNCTION canopy_touch_updated_at();--> statement-breakpoint
CREATE TRIGGER "act_touch_updated_at" BEFORE UPDATE ON "act" FOR EACH ROW EXECUTE FUNCTION canopy_touch_updated_at();--> statement-breakpoint
CREATE TRIGGER "category_touch_updated_at" BEFORE UPDATE ON "category" FOR EACH ROW EXECUTE FUNCTION canopy_touch_updated_at();--> statement-breakpoint
CREATE TRIGGER "obligation_touch_updated_at" BEFORE UPDATE ON "obligation" FOR EACH ROW EXECUTE FUNCTION canopy_touch_updated_at();--> statement-breakpoint
CREATE TRIGGER "assignment_touch_updated_at" BEFORE UPDATE ON "assignment" FOR EACH ROW EXECUTE FUNCTION canopy_touch_updated_at();--> statement-breakpoint
CREATE TRIGGER "compliance_instance_touch_updated_at" BEFORE UPDATE ON "compliance_instance" FOR EACH ROW EXECUTE FUNCTION canopy_touch_updated_at();--> statement-breakpoint
CREATE TRIGGER "evidence_touch_updated_at" BEFORE UPDATE ON "evidence" FOR EACH ROW EXECUTE FUNCTION canopy_touch_updated_at();--> statement-breakpoint
CREATE TRIGGER "comment_touch_updated_at" BEFORE UPDATE ON "comment" FOR EACH ROW EXECUTE FUNCTION canopy_touch_updated_at();--> statement-breakpoint
CREATE TRIGGER "mapping_template_touch_updated_at" BEFORE UPDATE ON "mapping_template" FOR EACH ROW EXECUTE FUNCTION canopy_touch_updated_at();--> statement-breakpoint
CREATE TRIGGER "import_batch_touch_updated_at" BEFORE UPDATE ON "import_batch" FOR EACH ROW EXECUTE FUNCTION canopy_touch_updated_at();--> statement-breakpoint
CREATE TRIGGER "import_row_touch_updated_at" BEFORE UPDATE ON "import_row" FOR EACH ROW EXECUTE FUNCTION canopy_touch_updated_at();--> statement-breakpoint
CREATE TRIGGER "import_issue_touch_updated_at" BEFORE UPDATE ON "import_issue" FOR EACH ROW EXECUTE FUNCTION canopy_touch_updated_at();--> statement-breakpoint
CREATE TRIGGER "export_job_touch_updated_at" BEFORE UPDATE ON "export_job" FOR EACH ROW EXECUTE FUNCTION canopy_touch_updated_at();--> statement-breakpoint

-- Append-only audit trail, for every role including the owner.
CREATE TRIGGER "audit_event_append_only" BEFORE UPDATE OR DELETE ON "audit_event" FOR EACH ROW EXECUTE FUNCTION canopy_reject_audit_change();--> statement-breakpoint
CREATE TRIGGER "audit_event_no_truncate" BEFORE TRUNCATE ON "audit_event" FOR EACH STATEMENT EXECUTE FUNCTION canopy_reject_audit_change();
