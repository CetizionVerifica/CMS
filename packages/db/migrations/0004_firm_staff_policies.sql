DROP POLICY "tenant_isolation" ON "firm" CASCADE;--> statement-breakpoint
DROP POLICY "tenant_isolation" ON "location" CASCADE;--> statement-breakpoint
DROP POLICY "tenant_isolation" ON "person" CASCADE;--> statement-breakpoint
DROP POLICY "tenant_isolation" ON "act" CASCADE;--> statement-breakpoint
DROP POLICY "tenant_isolation" ON "category" CASCADE;--> statement-breakpoint
DROP POLICY "tenant_isolation" ON "obligation" CASCADE;--> statement-breakpoint
CREATE POLICY "tenant_read" ON "firm" AS PERMISSIVE FOR SELECT TO public USING (id = app_firm_id());--> statement-breakpoint
CREATE POLICY "tenant_insert" ON "firm" AS PERMISSIVE FOR INSERT TO public WITH CHECK (id = app_firm_id());--> statement-breakpoint
CREATE POLICY "tenant_update" ON "firm" AS PERMISSIVE FOR UPDATE TO public USING (id = app_firm_id() and app_firm_staff()) WITH CHECK (id = app_firm_id() and app_firm_staff());--> statement-breakpoint
CREATE POLICY "tenant_read" ON "location" AS PERMISSIVE FOR SELECT TO public USING (firm_id = app_firm_id());--> statement-breakpoint
CREATE POLICY "tenant_insert" ON "location" AS PERMISSIVE FOR INSERT TO public WITH CHECK (firm_id = app_firm_id());--> statement-breakpoint
CREATE POLICY "tenant_update" ON "location" AS PERMISSIVE FOR UPDATE TO public USING (firm_id = app_firm_id() and app_firm_staff()) WITH CHECK (firm_id = app_firm_id() and app_firm_staff());--> statement-breakpoint
CREATE POLICY "tenant_read" ON "person" AS PERMISSIVE FOR SELECT TO public USING (firm_id = app_firm_id() and (app_firm_staff() or id = app_person_id() or app_person_visible(id)));--> statement-breakpoint
CREATE POLICY "tenant_insert" ON "person" AS PERMISSIVE FOR INSERT TO public WITH CHECK (firm_id = app_firm_id());--> statement-breakpoint
CREATE POLICY "tenant_update" ON "person" AS PERMISSIVE FOR UPDATE TO public USING (firm_id = app_firm_id() and (app_firm_staff() or ((id = app_person_id() or app_person_visible(id)) and not app_person_has_firm_role(id)))) WITH CHECK (firm_id = app_firm_id());--> statement-breakpoint
CREATE POLICY "tenant_read" ON "act" AS PERMISSIVE FOR SELECT TO public USING (firm_id = app_firm_id());--> statement-breakpoint
CREATE POLICY "tenant_insert" ON "act" AS PERMISSIVE FOR INSERT TO public WITH CHECK (firm_id = app_firm_id() and app_firm_staff());--> statement-breakpoint
CREATE POLICY "tenant_update" ON "act" AS PERMISSIVE FOR UPDATE TO public USING (firm_id = app_firm_id() and app_firm_staff()) WITH CHECK (firm_id = app_firm_id() and app_firm_staff());--> statement-breakpoint
CREATE POLICY "tenant_read" ON "category" AS PERMISSIVE FOR SELECT TO public USING (firm_id = app_firm_id());--> statement-breakpoint
CREATE POLICY "tenant_insert" ON "category" AS PERMISSIVE FOR INSERT TO public WITH CHECK (firm_id = app_firm_id() and app_firm_staff());--> statement-breakpoint
CREATE POLICY "tenant_update" ON "category" AS PERMISSIVE FOR UPDATE TO public USING (firm_id = app_firm_id() and app_firm_staff()) WITH CHECK (firm_id = app_firm_id() and app_firm_staff());--> statement-breakpoint
CREATE POLICY "tenant_read" ON "obligation" AS PERMISSIVE FOR SELECT TO public USING (firm_id = app_firm_id());--> statement-breakpoint
CREATE POLICY "tenant_insert" ON "obligation" AS PERMISSIVE FOR INSERT TO public WITH CHECK (firm_id = app_firm_id() and app_firm_staff());--> statement-breakpoint
CREATE POLICY "tenant_update" ON "obligation" AS PERMISSIVE FOR UPDATE TO public USING (firm_id = app_firm_id() and app_firm_staff()) WITH CHECK (firm_id = app_firm_id() and app_firm_staff());