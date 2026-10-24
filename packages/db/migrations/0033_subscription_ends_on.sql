-- The last day of the context's account's latest paid subscription, or null when it has none (ADR M15-0001 decision
-- 4: renewal reminders to the account's admins). The tenant cannot read platform.subscription, so this function,
-- owned by canopy_platform as app_account() is, answers for the account in the context only: a date, never an
-- amount, invoice or operator. "Latest" is the subscription that ends last, as the console's Renewals page reads it.
-- Custom migration: Drizzle Kit does not model functions or grants. canopy_platform gains SELECT on the table for the
-- function's read only; canopy_app still has no grant on it.
GRANT SELECT ON "platform"."subscription" TO canopy_platform;--> statement-breakpoint
CREATE FUNCTION app_subscription_ends_on()
RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT max(s.ends_on) FROM platform.subscription s WHERE s.account_id = app_firm_id()
$$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO canopy_platform;--> statement-breakpoint
ALTER FUNCTION app_subscription_ends_on() OWNER TO canopy_platform;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM canopy_platform;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_subscription_ends_on() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_subscription_ends_on() TO canopy_app;
