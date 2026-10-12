DROP INDEX "notification_send_instance_key";--> statement-breakpoint
CREATE UNIQUE INDEX "notification_send_instance_key" ON "notification_send" USING btree ("instance_id","kind","send_date","recipient_id") WHERE instance_id is not null;--> statement-breakpoint
CREATE POLICY "lookup_read" ON "firm" AS PERMISSIVE FOR SELECT TO "canopy_lookup" USING (true);