CREATE TABLE "auth_credential" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"firm_id" uuid DEFAULT app_firm_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"password_hash" text,
	"mfa_sealed_secret" text,
	"mfa_enrolled_at" timestamp with time zone,
	"mfa_last_step" bigint,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_credential_failed_attempts_check" CHECK (failed_attempts >= 0),
	CONSTRAINT "auth_credential_mfa_check" CHECK ((mfa_enrolled_at is null or mfa_sealed_secret is not null) and (mfa_last_step is null or mfa_last_step >= 0))
);
--> statement-breakpoint
ALTER TABLE "auth_credential" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "auth_invite" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"firm_id" uuid DEFAULT app_firm_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "role" NOT NULL,
	"client_id" uuid,
	"consultant_client_ids" uuid[],
	"unit_ids" uuid[],
	"membership_expires_at" timestamp with time zone,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "auth_invite_firm_key" UNIQUE("firm_id","id"),
	CONSTRAINT "auth_invite_person_key" UNIQUE("firm_id","id","person_id"),
	CONSTRAINT "auth_invite_client_role_check" CHECK ((role in ('FIRM_ADMIN', 'CONSULTANT')) = (client_id is null)),
	CONSTRAINT "auth_invite_consultant_check" CHECK ((role = 'CONSULTANT') = (consultant_client_ids is not null)),
	CONSTRAINT "auth_invite_unit_ids_check" CHECK (unit_ids is null or (role in ('OWNER', 'APPROVER') and cardinality(unit_ids) >= 1)),
	CONSTRAINT "auth_invite_viewer_expiry_check" CHECK (role <> 'VIEWER' or membership_expires_at is not null),
	CONSTRAINT "auth_invite_closed_check" CHECK (accepted_at is null or revoked_at is null)
);
--> statement-breakpoint
ALTER TABLE "auth_invite" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"firm_id" uuid DEFAULT app_firm_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"csrf_token" text NOT NULL,
	"mfa_satisfied" boolean DEFAULT false NOT NULL,
	"method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "auth_session_token_hash_check" CHECK (token_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "auth_session_csrf_check" CHECK (length(csrf_token) >= 32),
	CONSTRAINT "auth_session_method_check" CHECK (method in ('PASSWORD', 'MAGIC_LINK', 'INVITE')),
	CONSTRAINT "auth_session_expiry_check" CHECK (expires_at > created_at)
);
--> statement-breakpoint
ALTER TABLE "auth_session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "auth_token" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"firm_id" uuid DEFAULT app_firm_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"invite_id" uuid,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "auth_token_hash_check" CHECK (token_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "auth_token_kind_check" CHECK ((kind = 'MAGIC_LINK' and invite_id is null) or (kind = 'INVITE' and invite_id is not null))
);
--> statement-breakpoint
ALTER TABLE "auth_token" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "auth_credential" ADD CONSTRAINT "auth_credential_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_credential" ADD CONSTRAINT "auth_credential_person_fk" FOREIGN KEY ("firm_id","person_id") REFERENCES "public"."person"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_invite" ADD CONSTRAINT "auth_invite_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_invite" ADD CONSTRAINT "auth_invite_person_fk" FOREIGN KEY ("firm_id","person_id") REFERENCES "public"."person"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_invite" ADD CONSTRAINT "auth_invite_created_by_fk" FOREIGN KEY ("firm_id","created_by_id") REFERENCES "public"."person"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_invite" ADD CONSTRAINT "auth_invite_client_fk" FOREIGN KEY ("firm_id","client_id") REFERENCES "public"."client"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_person_fk" FOREIGN KEY ("firm_id","person_id") REFERENCES "public"."person"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_token" ADD CONSTRAINT "auth_token_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_token" ADD CONSTRAINT "auth_token_person_fk" FOREIGN KEY ("firm_id","person_id") REFERENCES "public"."person"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_token" ADD CONSTRAINT "auth_token_invite_fk" FOREIGN KEY ("firm_id","invite_id","person_id") REFERENCES "public"."auth_invite"("firm_id","id","person_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_credential_person_key" ON "auth_credential" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "auth_invite_person_idx" ON "auth_invite" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "auth_invite_client_idx" ON "auth_invite" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_session_token_key" ON "auth_session" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_session_person_idx" ON "auth_session" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_token_hash_key" ON "auth_token" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_token_person_idx" ON "auth_token" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "auth_token_invite_idx" ON "auth_token" USING btree ("invite_id");--> statement-breakpoint
CREATE INDEX "person_email_lookup_idx" ON "person" USING btree (lower("email")) WHERE email is not null and archived_at is null;--> statement-breakpoint
CREATE POLICY "lookup_read" ON "person" AS PERMISSIVE FOR SELECT TO "canopy_lookup" USING (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "auth_credential" AS PERMISSIVE FOR ALL TO public USING (firm_id = app_firm_id() and (person_id = app_person_id() or app_firm_staff())) WITH CHECK (firm_id = app_firm_id() and (person_id = app_person_id() or app_firm_staff()));--> statement-breakpoint
CREATE POLICY "lookup_read" ON "auth_credential" AS PERMISSIVE FOR SELECT TO "canopy_lookup" USING (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "auth_invite" AS PERMISSIVE FOR ALL TO public USING (firm_id = app_firm_id() and (person_id = app_person_id() or app_firm_staff() or (client_id is not null and app_can_see_client(client_id)))) WITH CHECK (firm_id = app_firm_id() and (person_id = app_person_id() or app_firm_staff() or (client_id is not null and app_can_see_client(client_id))));--> statement-breakpoint
CREATE POLICY "lookup_read" ON "auth_invite" AS PERMISSIVE FOR SELECT TO "canopy_lookup" USING (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "auth_session" AS PERMISSIVE FOR ALL TO public USING (firm_id = app_firm_id() and (person_id = app_person_id() or app_firm_staff())) WITH CHECK (firm_id = app_firm_id() and (person_id = app_person_id() or app_firm_staff()));--> statement-breakpoint
CREATE POLICY "lookup_read" ON "auth_session" AS PERMISSIVE FOR SELECT TO "canopy_lookup" USING (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "auth_token" AS PERMISSIVE FOR ALL TO public USING (firm_id = app_firm_id() and (person_id = app_person_id() or app_firm_staff() or (invite_id is not null and exists (select 1 from auth_invite i where i.id = invite_id)))) WITH CHECK (firm_id = app_firm_id() and (person_id = app_person_id() or app_firm_staff() or (invite_id is not null and exists (select 1 from auth_invite i where i.id = invite_id))));--> statement-breakpoint
CREATE POLICY "lookup_read" ON "auth_token" AS PERMISSIVE FOR SELECT TO "canopy_lookup" USING (true);