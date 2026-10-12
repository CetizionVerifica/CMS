DROP INDEX "notification_send_instance_key";--> statement-breakpoint
DROP INDEX "notification_send_digest_key";--> statement-breakpoint
ALTER TABLE "notification_send" ADD COLUMN "event_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_send_event_key" ON "notification_send" USING btree ("firm_id","event_id","recipient_id") WHERE event_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_send_instance_key" ON "notification_send" USING btree ("instance_id","kind","send_date","recipient_id") WHERE instance_id is not null and event_id is null;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_send_digest_key" ON "notification_send" USING btree ("recipient_id","kind","send_date") WHERE instance_id is null and event_id is null;