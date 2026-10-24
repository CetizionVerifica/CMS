-- The one-END-per-grant index (0030) covers only the grant's own ends, by revoke ('grant') or by expiry ('expiry'), so a
-- later END that names a grant from another source (a support session's would use 'session', keyed on its session
-- id) neither fails on it nor makes a grant's own END be skipped (#228 audit, Low). The index holds the same rows
-- today: every END so far has one of the two sources.
DROP INDEX "platform"."operator_audit_event_support_end_key";--> statement-breakpoint
CREATE UNIQUE INDEX "operator_audit_event_support_end_key" ON "platform"."operator_audit_event" USING btree ((after->>'grantId')) WHERE action = 'SUPPORT_ACCESS_END' and after->>'source' in ('grant', 'expiry');