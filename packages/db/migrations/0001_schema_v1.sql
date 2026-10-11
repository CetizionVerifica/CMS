CREATE TYPE "public"."applicability" AS ENUM('APPLICABLE', 'NOT_APPLICABLE', 'TO_ASSESS');--> statement-breakpoint
CREATE TYPE "public"."audit_action" AS ENUM('CREATE', 'UPDATE', 'ARCHIVE', 'RESTORE', 'TRANSITION', 'REASSIGN', 'DUE_DATE_CHANGE', 'APPLICABILITY_CHANGE', 'EVIDENCE_ADD', 'EVIDENCE_REMOVE', 'EVIDENCE_DOWNLOAD', 'IMPORT', 'MERGE_ALIAS', 'MEMBERSHIP_CHANGE', 'LOGIN', 'EXPORT');--> statement-breakpoint
CREATE TYPE "public"."audit_actor_kind" AS ENUM('PERSON', 'SYSTEM', 'IMPORT');--> statement-breakpoint
CREATE TYPE "public"."canopy_field" AS ENUM('externalRef', 'title', 'timelineType', 'description', 'category', 'applicabilityText', 'act', 'completedOn', 'status', 'dueDate', 'forms', 'logSheets', 'organizationPath', 'locationPath', 'owner', 'ownerComment', 'approver', 'department', 'criticality');--> statement-breakpoint
CREATE TYPE "public"."comment_kind" AS ENUM('NOTE', 'SUBMIT', 'NA_REQUEST', 'APPROVE', 'SEND_BACK', 'REOPEN', 'IMPORT');--> statement-breakpoint
CREATE TYPE "public"."criticality" AS ENUM('SUPER_CRITICAL', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW');--> statement-breakpoint
CREATE TYPE "public"."entity_type" AS ENUM('client', 'company', 'unit', 'location', 'department', 'person', 'membership', 'act', 'category', 'obligation', 'assignment', 'instance', 'evidence', 'import_batch', 'export');--> statement-breakpoint
CREATE TYPE "public"."export_kind" AS ENUM('REGISTER_XLSX', 'CERTIFICATE_PDF', 'ACT_REPORT_XLSX', 'DEPARTMENT_REPORT_XLSX', 'OVERDUE_REPORT_XLSX');--> statement-breakpoint
CREATE TYPE "public"."import_batch_status" AS ENUM('UPLOADED', 'MAPPED', 'PARSED', 'REVIEWED', 'DRY_RUN_READY', 'COMMITTING', 'COMMITTED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."import_issue_type" AS ENUM('PERSON_CASE_MERGE', 'PERSON_NEAR_MATCH', 'ENUM_NORMALISED', 'UNKNOWN_ENUM', 'ALIAS_DEPARTMENT', 'ALIAS_CATEGORY', 'ALIAS_ACT', 'NULL_PLACEHOLDER', 'COMPLIED_WITHOUT_DATE', 'DUPLICATE_PERIOD', 'CONFLICTING_OBLIGATION_VALUE', 'RULE_LOW_CONFIDENCE', 'FILE_NOT_ATTACHED', 'UNPARSED_EXTERNAL_REF', 'INVALID_DATE', 'MISSING_REQUIRED');--> statement-breakpoint
CREATE TYPE "public"."import_row_outcome" AS ENUM('PENDING', 'CREATE', 'UPDATE', 'UNCHANGED', 'SKIPPED', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."issue_decision" AS ENUM('PENDING', 'ACCEPTED', 'REJECTED', 'EDITED');--> statement-breakpoint
CREATE TYPE "public"."issue_severity" AS ENUM('INFO', 'WARNING', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('QUEUED', 'RUNNING', 'DONE', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."jurisdiction" AS ENUM('CENTRAL', 'STATE');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('OWNER_REMINDER', 'APPROVER_ESCALATION', 'CONSULTANT_DIGEST', 'INVITE', 'MAGIC_LINK', 'EXPORT_READY');--> statement-breakpoint
CREATE TYPE "public"."obligation_domain" AS ENUM('HRS', 'EHS', 'TAX', 'IT', 'INT', 'ENG', 'ENV', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."person_status" AS ENUM('UNCLAIMED', 'INVITED', 'ACTIVE', 'DISABLED');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('FIRM_ADMIN', 'CONSULTANT', 'CLIENT_ADMIN', 'APPROVER', 'OWNER', 'VIEWER');--> statement-breakpoint
CREATE TYPE "public"."rule_status" AS ENUM('CONFIRMED', 'TO_REVIEW');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('PENDING', 'CLEAN', 'INFECTED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."submission_kind" AS ENUM('COMPLETION', 'NA');--> statement-breakpoint
CREATE TYPE "public"."timeline_type" AS ENUM('TIME_BASED', 'ONGOING');--> statement-breakpoint
CREATE TYPE "public"."workflow_state" AS ENUM('OPEN', 'SUBMITTED', 'SENT_BACK', 'APPROVED', 'NOT_APPLICABLE');--> statement-breakpoint
CREATE TABLE "firm" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"name" text NOT NULL,
	"settings" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "firm_version_check" CHECK (version >= 1)
);
--> statement-breakpoint
ALTER TABLE "firm" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "client" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"firm_id" uuid DEFAULT app_firm_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"settings" jsonb NOT NULL,
	CONSTRAINT "client_firm_key" UNIQUE("firm_id","id"),
	CONSTRAINT "client_version_check" CHECK (version >= 1)
);
--> statement-breakpoint
ALTER TABLE "client" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "company" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"firm_id" uuid DEFAULT app_firm_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "company_scope_key" UNIQUE("firm_id","client_id","id"),
	CONSTRAINT "company_version_check" CHECK (version >= 1)
);
--> statement-breakpoint
ALTER TABLE "company" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "department" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"firm_id" uuid DEFAULT app_firm_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "department_scope_key" UNIQUE("firm_id","client_id","id"),
	CONSTRAINT "department_version_check" CHECK (version >= 1)
);
--> statement-breakpoint
ALTER TABLE "department" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "location" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"firm_id" uuid DEFAULT app_firm_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"country" text NOT NULL,
	"country_code" text NOT NULL,
	"state" text,
	"state_code" text,
	"city" text,
	CONSTRAINT "location_firm_key" UNIQUE("firm_id","id"),
	CONSTRAINT "location_country_code_check" CHECK (country_code ~ '^[A-Z]{2}$'),
	CONSTRAINT "location_state_code_check" CHECK (state_code is null or state_code ~ '^[A-Z]{2,3}$')
);
--> statement-breakpoint
ALTER TABLE "location" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "membership" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"firm_id" uuid DEFAULT app_firm_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"person_id" uuid NOT NULL,
	"role" "role" NOT NULL,
	"client_id" uuid,
	"consultant_client_ids" uuid[],
	"unit_ids" uuid[],
	"expires_at" timestamp with time zone,
	CONSTRAINT "membership_client_role_check" CHECK ((role in ('FIRM_ADMIN', 'CONSULTANT')) = (client_id is null)),
	CONSTRAINT "membership_consultant_check" CHECK ((role = 'CONSULTANT') = (consultant_client_ids is not null)),
	CONSTRAINT "membership_unit_ids_check" CHECK (unit_ids is null or (role in ('OWNER', 'APPROVER') and cardinality(unit_ids) >= 1)),
	CONSTRAINT "membership_viewer_expiry_check" CHECK (role <> 'VIEWER' or expires_at is not null),
	CONSTRAINT "membership_version_check" CHECK (version >= 1)
);
--> statement-breakpoint
ALTER TABLE "membership" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "person" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"firm_id" uuid DEFAULT app_firm_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"display_name" text NOT NULL,
	"name_normalized" text NOT NULL,
	"email" text,
	"status" "person_status" NOT NULL,
	CONSTRAINT "person_firm_key" UNIQUE("firm_id","id"),
	CONSTRAINT "person_name_normalized_check" CHECK (name_normalized = lower(name_normalized) and name_normalized !~ '[\t\n\r\f\v]|  '),
	CONSTRAINT "person_email_status_check" CHECK ((status <> 'UNCLAIMED' or email is null) and (status not in ('INVITED', 'ACTIVE') or email is not null)),
	CONSTRAINT "person_version_check" CHECK (version >= 1)
);
--> statement-breakpoint
ALTER TABLE "person" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "unit" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"firm_id" uuid DEFAULT app_firm_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"client_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"location_id" uuid NOT NULL,
	CONSTRAINT "unit_scope_key" UNIQUE("firm_id","client_id","id"),
	CONSTRAINT "unit_version_check" CHECK (version >= 1)
);
--> statement-breakpoint
ALTER TABLE "unit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "act" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"firm_id" uuid DEFAULT app_firm_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"short_name" text,
	"jurisdiction" "jurisdiction" NOT NULL,
	"state_code" text,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "act_firm_key" UNIQUE("firm_id","id"),
	CONSTRAINT "act_jurisdiction_check" CHECK ((jurisdiction = 'STATE') = (state_code is not null) and (state_code is null or state_code ~ '^[A-Z]{2,3}$')),
	CONSTRAINT "act_version_check" CHECK (version >= 1)
);
--> statement-breakpoint
ALTER TABLE "act" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "category" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"firm_id" uuid DEFAULT app_firm_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "category_firm_key" UNIQUE("firm_id","id"),
	CONSTRAINT "category_version_check" CHECK (version >= 1)
);
--> statement-breakpoint
ALTER TABLE "category" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "obligation" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"firm_id" uuid DEFAULT app_firm_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"external_ref" text,
	"domain" "obligation_domain" NOT NULL,
	"jurisdiction" "jurisdiction" NOT NULL,
	"state_code" text,
	"act_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"applicability_text" text,
	"criticality" "criticality" NOT NULL,
	"timeline_type" timeline_type NOT NULL,
	"recurrence_rule" jsonb NOT NULL,
	"rule_status" "rule_status" NOT NULL,
	"evidence_required" boolean DEFAULT false NOT NULL,
	"forms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"log_sheets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"library_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "obligation_firm_key" UNIQUE("firm_id","id"),
	CONSTRAINT "obligation_jurisdiction_check" CHECK ((jurisdiction = 'STATE') = (state_code is not null) and (state_code is null or state_code ~ '^[A-Z]{2,3}$')),
	CONSTRAINT "obligation_recurrence_rule_check" CHECK (jsonb_typeof(recurrence_rule) = 'object' and recurrence_rule ? 'kind'),
	CONSTRAINT "obligation_templates_check" CHECK (jsonb_typeof(forms) = 'array' and jsonb_typeof(log_sheets) = 'array'),
	CONSTRAINT "obligation_library_version_check" CHECK (library_version >= 1),
	CONSTRAINT "obligation_version_check" CHECK (version >= 1)
);
--> statement-breakpoint
ALTER TABLE "obligation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "assignment" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"firm_id" uuid DEFAULT app_firm_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"client_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"obligation_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"default_owner_id" uuid NOT NULL,
	"default_approver_id" uuid NOT NULL,
	"applicability" "applicability" NOT NULL,
	"na_reason" text,
	"active_from" date NOT NULL,
	"active_to" date,
	CONSTRAINT "assignment_scope_key" UNIQUE("firm_id","client_id","unit_id","id"),
	CONSTRAINT "assignment_na_reason_check" CHECK (applicability <> 'NOT_APPLICABLE' or na_reason is not null),
	CONSTRAINT "assignment_active_range_check" CHECK (active_to is null or active_to >= active_from),
	CONSTRAINT "assignment_version_check" CHECK (version >= 1)
);
--> statement-breakpoint
ALTER TABLE "assignment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"firm_id" uuid DEFAULT app_firm_id() NOT NULL,
	"client_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" text NOT NULL,
	"actor_id" uuid,
	"actor_kind" "audit_actor_kind" NOT NULL,
	"action" "audit_action" NOT NULL,
	"entity_type" "entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	CONSTRAINT "audit_event_actor_check" CHECK (actor_kind <> 'PERSON' or actor_id is not null),
	CONSTRAINT "audit_event_request_id_check" CHECK (length(request_id) between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "audit_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "comment" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"firm_id" uuid DEFAULT app_firm_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"instance_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"author_id" uuid,
	"kind" "comment_kind" NOT NULL,
	"body" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "compliance_instance" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"firm_id" uuid DEFAULT app_firm_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"client_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"due_date" date NOT NULL,
	"workflow_state" "workflow_state" DEFAULT 'OPEN' NOT NULL,
	"pending_kind" "submission_kind",
	"completed_on" date,
	"na_reason" text,
	"owner_id" uuid NOT NULL,
	"approver_id" uuid NOT NULL,
	"submitted_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"due_date_overridden" boolean DEFAULT false NOT NULL,
	CONSTRAINT "compliance_instance_scope_key" UNIQUE("firm_id","client_id","id"),
	CONSTRAINT "compliance_instance_assignment_period_key" UNIQUE("assignment_id","period_start"),
	CONSTRAINT "compliance_instance_period_check" CHECK (period_end >= period_start),
	CONSTRAINT "compliance_instance_pending_kind_check" CHECK ((workflow_state = 'SUBMITTED') = (pending_kind is not null)),
	CONSTRAINT "compliance_instance_completed_on_check" CHECK (completed_on is not null or not (workflow_state in ('APPROVED', 'NOT_APPLICABLE') or (workflow_state = 'SUBMITTED' and pending_kind = 'COMPLETION'))),
	CONSTRAINT "compliance_instance_na_reason_check" CHECK (na_reason is not null or not (workflow_state = 'NOT_APPLICABLE' or pending_kind = 'NA')),
	CONSTRAINT "compliance_instance_version_check" CHECK (version >= 1)
);
--> statement-breakpoint
ALTER TABLE "compliance_instance" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"firm_id" uuid DEFAULT app_firm_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"instance_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"scan_status" "scan_status" DEFAULT 'PENDING' NOT NULL,
	"uploaded_by_id" uuid NOT NULL,
	CONSTRAINT "evidence_size_check" CHECK (size_bytes between 1 and 26214400),
	CONSTRAINT "evidence_sha256_check" CHECK (sha256 ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "import_batch" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"firm_id" uuid DEFAULT app_firm_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"client_id" uuid NOT NULL,
	"created_by_id" uuid NOT NULL,
	"status" "import_batch_status" DEFAULT 'UPLOADED' NOT NULL,
	"file_name" text NOT NULL,
	"file_sha256" text NOT NULL,
	"sheet_name" text,
	"mapping" jsonb,
	"mapping_template_id" uuid,
	"counts" jsonb,
	"dry_run" jsonb,
	"committed_at" timestamp with time zone,
	"failure_code" text,
	CONSTRAINT "import_batch_scope_key" UNIQUE("firm_id","client_id","id"),
	CONSTRAINT "import_batch_sha256_check" CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "import_batch_version_check" CHECK (version >= 1)
);
--> statement-breakpoint
ALTER TABLE "import_batch" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "import_issue" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"firm_id" uuid DEFAULT app_firm_id() NOT NULL,
	"client_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"group_key" text NOT NULL,
	"type" "import_issue_type" NOT NULL,
	"severity" "issue_severity" NOT NULL,
	"row_numbers" integer[] NOT NULL,
	"field" "canopy_field",
	"raw_values" text[] DEFAULT '{}'::text[] NOT NULL,
	"proposal" text,
	"decision" "issue_decision" DEFAULT 'PENDING' NOT NULL,
	"edited_value" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_issue_severity_check" CHECK (severity = case type when 'PERSON_CASE_MERGE' then 'INFO' when 'PERSON_NEAR_MATCH' then 'WARNING' when 'ENUM_NORMALISED' then 'INFO' when 'UNKNOWN_ENUM' then 'ERROR' when 'ALIAS_DEPARTMENT' then 'WARNING' when 'ALIAS_CATEGORY' then 'WARNING' when 'ALIAS_ACT' then 'WARNING' when 'NULL_PLACEHOLDER' then 'INFO' when 'COMPLIED_WITHOUT_DATE' then 'WARNING' when 'DUPLICATE_PERIOD' then 'WARNING' when 'CONFLICTING_OBLIGATION_VALUE' then 'INFO' when 'RULE_LOW_CONFIDENCE' then 'WARNING' when 'FILE_NOT_ATTACHED' then 'INFO' when 'UNPARSED_EXTERNAL_REF' then 'INFO' when 'INVALID_DATE' then 'ERROR' when 'MISSING_REQUIRED' then 'ERROR' end::issue_severity),
	CONSTRAINT "import_issue_row_numbers_check" CHECK (cardinality(row_numbers) >= 1 and 2 <= all(row_numbers)),
	CONSTRAINT "import_issue_edited_value_check" CHECK ((decision = 'EDITED') = (edited_value is not null))
);
--> statement-breakpoint
ALTER TABLE "import_issue" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "import_row" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"firm_id" uuid DEFAULT app_firm_id() NOT NULL,
	"client_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"raw" jsonb NOT NULL,
	"mapped" jsonb,
	"issue_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"outcome" "import_row_outcome" DEFAULT 'PENDING' NOT NULL,
	"target_instance_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_row_batch_row_key" UNIQUE("batch_id","row_number"),
	CONSTRAINT "import_row_row_number_check" CHECK (row_number >= 2),
	CONSTRAINT "import_row_raw_check" CHECK (jsonb_typeof(raw) = 'object')
);
--> statement-breakpoint
ALTER TABLE "import_row" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mapping_template" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"firm_id" uuid DEFAULT app_firm_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"client_id" uuid,
	"name" text NOT NULL,
	"mapping" jsonb NOT NULL,
	CONSTRAINT "mapping_template_firm_key" UNIQUE("firm_id","id"),
	CONSTRAINT "mapping_template_mapping_check" CHECK (jsonb_typeof(mapping) = 'array'),
	CONSTRAINT "mapping_template_version_check" CHECK (version >= 1)
);
--> statement-breakpoint
ALTER TABLE "mapping_template" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "domain_event" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"firm_id" uuid DEFAULT app_firm_id() NOT NULL,
	"client_id" uuid,
	"type" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" jsonb NOT NULL,
	"request_id" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"aggregate_version" integer NOT NULL,
	"data" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "domain_event_type_check" CHECK (type ~ '^[a-z_]+\.[a-z_]+$'),
	CONSTRAINT "domain_event_attempts_check" CHECK (attempts >= 0)
);
--> statement-breakpoint
ALTER TABLE "domain_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "export_job" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"firm_id" uuid DEFAULT app_firm_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"client_id" uuid NOT NULL,
	"kind" "export_kind" NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'QUEUED' NOT NULL,
	"file_name" text,
	"storage_key" text,
	"requested_by_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "export_job" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notification_send" (
	"id" uuid PRIMARY KEY DEFAULT canopy_uuid_v7() NOT NULL,
	"firm_id" uuid DEFAULT app_firm_id() NOT NULL,
	"client_id" uuid NOT NULL,
	"instance_id" uuid,
	"recipient_id" uuid NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"send_date" date NOT NULL,
	"sent_at" timestamp with time zone,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_send" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "client" ADD CONSTRAINT "client_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_client_fk" FOREIGN KEY ("firm_id","client_id") REFERENCES "public"."client"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department" ADD CONSTRAINT "department_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department" ADD CONSTRAINT "department_client_fk" FOREIGN KEY ("firm_id","client_id") REFERENCES "public"."client"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_person_fk" FOREIGN KEY ("firm_id","person_id") REFERENCES "public"."person"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_client_fk" FOREIGN KEY ("firm_id","client_id") REFERENCES "public"."client"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit" ADD CONSTRAINT "unit_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit" ADD CONSTRAINT "unit_company_fk" FOREIGN KEY ("firm_id","client_id","company_id") REFERENCES "public"."company"("firm_id","client_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit" ADD CONSTRAINT "unit_location_fk" FOREIGN KEY ("firm_id","location_id") REFERENCES "public"."location"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "act" ADD CONSTRAINT "act_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligation" ADD CONSTRAINT "obligation_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligation" ADD CONSTRAINT "obligation_act_fk" FOREIGN KEY ("firm_id","act_id") REFERENCES "public"."act"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligation" ADD CONSTRAINT "obligation_category_fk" FOREIGN KEY ("firm_id","category_id") REFERENCES "public"."category"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_unit_fk" FOREIGN KEY ("firm_id","client_id","unit_id") REFERENCES "public"."unit"("firm_id","client_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_obligation_fk" FOREIGN KEY ("firm_id","obligation_id") REFERENCES "public"."obligation"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_department_fk" FOREIGN KEY ("firm_id","client_id","department_id") REFERENCES "public"."department"("firm_id","client_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_default_owner_fk" FOREIGN KEY ("firm_id","default_owner_id") REFERENCES "public"."person"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_default_approver_fk" FOREIGN KEY ("firm_id","default_approver_id") REFERENCES "public"."person"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_client_fk" FOREIGN KEY ("firm_id","client_id") REFERENCES "public"."client"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_instance_fk" FOREIGN KEY ("firm_id","client_id","instance_id") REFERENCES "public"."compliance_instance"("firm_id","client_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_author_fk" FOREIGN KEY ("firm_id","author_id") REFERENCES "public"."person"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_instance" ADD CONSTRAINT "compliance_instance_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_instance" ADD CONSTRAINT "compliance_instance_assignment_fk" FOREIGN KEY ("firm_id","client_id","unit_id","assignment_id") REFERENCES "public"."assignment"("firm_id","client_id","unit_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_instance" ADD CONSTRAINT "compliance_instance_owner_fk" FOREIGN KEY ("firm_id","owner_id") REFERENCES "public"."person"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_instance" ADD CONSTRAINT "compliance_instance_approver_fk" FOREIGN KEY ("firm_id","approver_id") REFERENCES "public"."person"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_instance_fk" FOREIGN KEY ("firm_id","client_id","instance_id") REFERENCES "public"."compliance_instance"("firm_id","client_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_uploaded_by_fk" FOREIGN KEY ("firm_id","uploaded_by_id") REFERENCES "public"."person"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_client_fk" FOREIGN KEY ("firm_id","client_id") REFERENCES "public"."client"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_created_by_fk" FOREIGN KEY ("firm_id","created_by_id") REFERENCES "public"."person"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_mapping_template_fk" FOREIGN KEY ("firm_id","mapping_template_id") REFERENCES "public"."mapping_template"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_issue" ADD CONSTRAINT "import_issue_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_issue" ADD CONSTRAINT "import_issue_batch_fk" FOREIGN KEY ("firm_id","client_id","batch_id") REFERENCES "public"."import_batch"("firm_id","client_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row" ADD CONSTRAINT "import_row_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row" ADD CONSTRAINT "import_row_batch_fk" FOREIGN KEY ("firm_id","client_id","batch_id") REFERENCES "public"."import_batch"("firm_id","client_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row" ADD CONSTRAINT "import_row_target_instance_fk" FOREIGN KEY ("firm_id","client_id","target_instance_id") REFERENCES "public"."compliance_instance"("firm_id","client_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mapping_template" ADD CONSTRAINT "mapping_template_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mapping_template" ADD CONSTRAINT "mapping_template_client_fk" FOREIGN KEY ("firm_id","client_id") REFERENCES "public"."client"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_event" ADD CONSTRAINT "domain_event_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_event" ADD CONSTRAINT "domain_event_client_fk" FOREIGN KEY ("firm_id","client_id") REFERENCES "public"."client"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_job" ADD CONSTRAINT "export_job_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_job" ADD CONSTRAINT "export_job_client_fk" FOREIGN KEY ("firm_id","client_id") REFERENCES "public"."client"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_job" ADD CONSTRAINT "export_job_requested_by_fk" FOREIGN KEY ("firm_id","requested_by_id") REFERENCES "public"."person"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_send" ADD CONSTRAINT "notification_send_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_send" ADD CONSTRAINT "notification_send_client_fk" FOREIGN KEY ("firm_id","client_id") REFERENCES "public"."client"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_send" ADD CONSTRAINT "notification_send_instance_fk" FOREIGN KEY ("firm_id","client_id","instance_id") REFERENCES "public"."compliance_instance"("firm_id","client_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_send" ADD CONSTRAINT "notification_send_recipient_fk" FOREIGN KEY ("firm_id","recipient_id") REFERENCES "public"."person"("firm_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_name_key" ON "company" USING btree ("client_id","name") WHERE archived_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "department_name_key" ON "department" USING btree ("client_id","name") WHERE archived_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "location_path_key" ON "location" USING btree ("firm_id","country_code",coalesce(lower("state"), ''),coalesce(lower("city"), '')) WHERE archived_at is null;--> statement-breakpoint
CREATE INDEX "membership_person_idx" ON "membership" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "membership_client_idx" ON "membership" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "person_name_normalized_idx" ON "person" USING btree ("firm_id","name_normalized");--> statement-breakpoint
CREATE UNIQUE INDEX "person_email_key" ON "person" USING btree ("firm_id",lower("email")) WHERE email is not null and archived_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "unit_name_key" ON "unit" USING btree ("company_id","name") WHERE archived_at is null;--> statement-breakpoint
CREATE INDEX "unit_location_idx" ON "unit" USING btree ("location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "act_name_key" ON "act" USING btree ("firm_id","name") WHERE archived_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "category_name_key" ON "category" USING btree ("firm_id","name") WHERE archived_at is null;--> statement-breakpoint
CREATE INDEX "obligation_external_ref_idx" ON "obligation" USING btree ("firm_id","external_ref");--> statement-breakpoint
CREATE INDEX "obligation_act_idx" ON "obligation" USING btree ("act_id");--> statement-breakpoint
CREATE INDEX "obligation_category_idx" ON "obligation" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_unit_obligation_department_key" ON "assignment" USING btree ("unit_id","obligation_id","department_id") WHERE archived_at is null;--> statement-breakpoint
CREATE INDEX "assignment_client_idx" ON "assignment" USING btree ("firm_id","client_id");--> statement-breakpoint
CREATE INDEX "assignment_obligation_idx" ON "assignment" USING btree ("obligation_id");--> statement-breakpoint
CREATE INDEX "assignment_department_idx" ON "assignment" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "assignment_default_owner_idx" ON "assignment" USING btree ("default_owner_id");--> statement-breakpoint
CREATE INDEX "assignment_default_approver_idx" ON "assignment" USING btree ("default_approver_id");--> statement-breakpoint
CREATE INDEX "audit_event_client_at_idx" ON "audit_event" USING btree ("firm_id","client_id","at");--> statement-breakpoint
CREATE INDEX "audit_event_entity_idx" ON "audit_event" USING btree ("entity_type","entity_id","at");--> statement-breakpoint
CREATE INDEX "comment_instance_idx" ON "comment" USING btree ("instance_id","created_at");--> statement-breakpoint
CREATE INDEX "compliance_instance_client_due_idx" ON "compliance_instance" USING btree ("firm_id","client_id","due_date");--> statement-breakpoint
CREATE INDEX "compliance_instance_owner_state_idx" ON "compliance_instance" USING btree ("owner_id","workflow_state");--> statement-breakpoint
CREATE INDEX "compliance_instance_approver_state_idx" ON "compliance_instance" USING btree ("approver_id","workflow_state");--> statement-breakpoint
CREATE INDEX "compliance_instance_unit_idx" ON "compliance_instance" USING btree ("unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_storage_key_key" ON "evidence" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "evidence_instance_idx" ON "evidence" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "evidence_client_idx" ON "evidence" USING btree ("firm_id","client_id","created_at");--> statement-breakpoint
CREATE INDEX "import_batch_client_idx" ON "import_batch" USING btree ("firm_id","client_id","created_at");--> statement-breakpoint
CREATE INDEX "import_batch_file_idx" ON "import_batch" USING btree ("client_id","file_sha256");--> statement-breakpoint
CREATE INDEX "import_issue_batch_idx" ON "import_issue" USING btree ("batch_id","group_key");--> statement-breakpoint
CREATE INDEX "import_row_target_instance_idx" ON "import_row" USING btree ("target_instance_id");--> statement-breakpoint
CREATE INDEX "mapping_template_client_idx" ON "mapping_template" USING btree ("firm_id","client_id");--> statement-breakpoint
CREATE INDEX "domain_event_unpublished_idx" ON "domain_event" USING btree ("occurred_at") WHERE published_at is null;--> statement-breakpoint
CREATE INDEX "domain_event_aggregate_idx" ON "domain_event" USING btree ("aggregate_type","aggregate_id","aggregate_version");--> statement-breakpoint
CREATE INDEX "export_job_client_idx" ON "export_job" USING btree ("firm_id","client_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_send_instance_key" ON "notification_send" USING btree ("instance_id","kind","send_date") WHERE instance_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_send_digest_key" ON "notification_send" USING btree ("recipient_id","kind","send_date") WHERE instance_id is null;--> statement-breakpoint
CREATE INDEX "notification_send_client_idx" ON "notification_send" USING btree ("firm_id","client_id","send_date");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "firm" AS PERMISSIVE FOR ALL TO public USING (id = app_firm_id()) WITH CHECK (id = app_firm_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "client" AS PERMISSIVE FOR ALL TO public USING (firm_id = app_firm_id() and app_can_see_client(id)) WITH CHECK (firm_id = app_firm_id() and app_can_see_client(id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "company" AS PERMISSIVE FOR ALL TO public USING (firm_id = app_firm_id() and app_can_see_client(client_id)) WITH CHECK (firm_id = app_firm_id() and app_can_see_client(client_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "department" AS PERMISSIVE FOR ALL TO public USING (firm_id = app_firm_id() and app_can_see_client(client_id)) WITH CHECK (firm_id = app_firm_id() and app_can_see_client(client_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "location" AS PERMISSIVE FOR ALL TO public USING (firm_id = app_firm_id()) WITH CHECK (firm_id = app_firm_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "membership" AS PERMISSIVE FOR ALL TO public USING (firm_id = app_firm_id() and (app_can_see_client(client_id) or person_id = app_person_id())) WITH CHECK (firm_id = app_firm_id() and app_can_see_client(client_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "person" AS PERMISSIVE FOR ALL TO public USING (firm_id = app_firm_id()) WITH CHECK (firm_id = app_firm_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "unit" AS PERMISSIVE FOR ALL TO public USING (firm_id = app_firm_id() and app_can_see_client(client_id)) WITH CHECK (firm_id = app_firm_id() and app_can_see_client(client_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "act" AS PERMISSIVE FOR ALL TO public USING (firm_id = app_firm_id()) WITH CHECK (firm_id = app_firm_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "category" AS PERMISSIVE FOR ALL TO public USING (firm_id = app_firm_id()) WITH CHECK (firm_id = app_firm_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "obligation" AS PERMISSIVE FOR ALL TO public USING (firm_id = app_firm_id()) WITH CHECK (firm_id = app_firm_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "assignment" AS PERMISSIVE FOR ALL TO public USING (firm_id = app_firm_id() and app_can_see_client(client_id)) WITH CHECK (firm_id = app_firm_id() and app_can_see_client(client_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_event" AS PERMISSIVE FOR ALL TO public USING (firm_id = app_firm_id() and app_can_see_client(client_id)) WITH CHECK (firm_id = app_firm_id() and (client_id is null or app_can_see_client(client_id)));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "comment" AS PERMISSIVE FOR ALL TO public USING (firm_id = app_firm_id() and app_can_see_client(client_id)) WITH CHECK (firm_id = app_firm_id() and app_can_see_client(client_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "compliance_instance" AS PERMISSIVE FOR ALL TO public USING (firm_id = app_firm_id() and app_can_see_client(client_id)) WITH CHECK (firm_id = app_firm_id() and app_can_see_client(client_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "evidence" AS PERMISSIVE FOR ALL TO public USING (firm_id = app_firm_id() and app_can_see_client(client_id)) WITH CHECK (firm_id = app_firm_id() and app_can_see_client(client_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "import_batch" AS PERMISSIVE FOR ALL TO public USING (firm_id = app_firm_id() and app_can_see_client(client_id)) WITH CHECK (firm_id = app_firm_id() and app_can_see_client(client_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "import_issue" AS PERMISSIVE FOR ALL TO public USING (firm_id = app_firm_id() and app_can_see_client(client_id)) WITH CHECK (firm_id = app_firm_id() and app_can_see_client(client_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "import_row" AS PERMISSIVE FOR ALL TO public USING (firm_id = app_firm_id() and app_can_see_client(client_id)) WITH CHECK (firm_id = app_firm_id() and app_can_see_client(client_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "mapping_template" AS PERMISSIVE FOR ALL TO public USING (firm_id = app_firm_id() and app_can_see_client(client_id)) WITH CHECK (firm_id = app_firm_id() and app_can_see_client(client_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "domain_event" AS PERMISSIVE FOR ALL TO public USING (firm_id = app_firm_id() and app_can_see_client(client_id)) WITH CHECK (firm_id = app_firm_id() and (client_id is null or app_can_see_client(client_id)));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "export_job" AS PERMISSIVE FOR ALL TO public USING (firm_id = app_firm_id() and app_can_see_client(client_id)) WITH CHECK (firm_id = app_firm_id() and app_can_see_client(client_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notification_send" AS PERMISSIVE FOR ALL TO public USING (firm_id = app_firm_id() and app_can_see_client(client_id)) WITH CHECK (firm_id = app_firm_id() and app_can_see_client(client_id));