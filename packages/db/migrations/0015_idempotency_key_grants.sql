-- M7's Idempotency-Key replay table (migration 0014). Forced RLS like every tenant table. DELETE is granted
-- only for the M9 purge; the restrictive delete_expired policy limits it to rows already expired.
ALTER TABLE "idempotency_key" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "idempotency_key" TO canopy_app;
