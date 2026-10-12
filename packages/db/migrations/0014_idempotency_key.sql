CREATE TABLE "idempotency_key" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"firm_id" uuid DEFAULT app_firm_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"key" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_key_key_check" CHECK (length(key) between 1 and 255),
	CONSTRAINT "idempotency_key_method_check" CHECK (method in ('POST', 'PUT', 'PATCH', 'DELETE')),
	CONSTRAINT "idempotency_key_path_check" CHECK (path ~ '^/' and length(path) <= 2048),
	CONSTRAINT "idempotency_key_request_hash_check" CHECK (request_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "idempotency_key_status_check" CHECK (response_status between 100 and 599),
	CONSTRAINT "idempotency_key_expiry_check" CHECK (expires_at > created_at)
);
--> statement-breakpoint
ALTER TABLE "idempotency_key" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_person_fk" FOREIGN KEY ("firm_id","person_id") REFERENCES "public"."person"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_key_key" ON "idempotency_key" USING btree ("firm_id","person_id","key");--> statement-breakpoint
CREATE INDEX "idempotency_key_expires_idx" ON "idempotency_key" USING btree ("firm_id","expires_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "idempotency_key" AS PERMISSIVE FOR ALL TO public USING (firm_id = app_firm_id() and (person_id = app_person_id() or app_firm_staff())) WITH CHECK (firm_id = app_firm_id() and (person_id = app_person_id() or app_firm_staff()));--> statement-breakpoint
CREATE POLICY "delete_expired" ON "idempotency_key" AS RESTRICTIVE FOR DELETE TO public USING (firm_id = app_firm_id() and expires_at < now());