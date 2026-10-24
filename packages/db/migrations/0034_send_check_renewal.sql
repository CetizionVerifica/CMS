-- The send log's no-client check names RENEWAL_DUE beside TRIAL_ENDING: the account admins' renewal reminder is about
-- the whole account, so its send has no client and no event. The kind is compared as text, as in 0030, so a fresh
-- database can apply 0032's new value and this check in one transaction.
--
-- A correction to 0033's header, which an applied migration cannot take: app_subscription_ends_on() reads the
-- account's latest recorded subscription whether or not it is paid, as the console's Renewals page does, not only a
-- paid one (audit of #233, Info 1).
ALTER TABLE "notification_send" DROP CONSTRAINT "notification_send_client_check";--> statement-breakpoint
ALTER TABLE "notification_send" ADD CONSTRAINT "notification_send_client_check" CHECK (client_id is not null or (instance_id is null and (event_id is not null or kind::text in ('TRIAL_ENDING', 'RENEWAL_DUE'))));
