# M15-0001. Operator-controlled customer accounts (M15)

- Status: accepted
- Date: 2026-10-24
- Module: M15 (`apps/api/src/platform`, `apps/operator`), with changes in M0, M3, M5, M6, M9, M10, M11, M13, M14

## Context

PlanetPulse sells the app to companies as a subscription. The platform operator (PlanetPulse staff) creates every
customer account; there is no public sign-up. Today a tenant is a `firm`, created only by `createFirm` on the owner
connection from the seed. We need customer accounts with a lifecycle, plans and limits, an operator console that
sits outside every tenant, and a way for PlanetPulse to help a customer without a back door into their data.

## Decisions

1. **An Account is a firm.** No new tenant level and no rename: the table stays `firm`, the column `firm_id`, and RLS
   is unchanged. The UI and customer documents say "Account"; `FIRM_ADMIN` reads "Account admin". `firm` gains
   `kind`, `status`, `plan_code`, `trial_ends_on` (date), `onboarded_at` (timestamptz), and the deletion columns of
   ADR M15-0002 (`deletion_requested_at`, `status_before_deletion`). Existing firms are backfilled
   `CONSULTANCY` / `ACTIVE` / `CONSULTANCY` plan.
2. **Two kinds.** `ENTERPRISE`: a company buying for itself; provisioning creates its one Client, and the web hides the
   client switcher and Portfolio while the account has one client. `CONSULTANCY`: the model built today, many clients.
3. **Lifecycle** (`AccountStatus`): `PROVISIONING` → (owner accepts the invite) → `TRIAL` when `trial_ends_on` is set,
   else `ACTIVE`; `TRIAL` → `ACTIVE` (operator converts); `TRIAL` → `SUSPENDED` (the day after `trial_ends_on`, in the
   account's time zone, by the M9 job); `ACTIVE` ⇄ `SUSPENDED` (operator, reason required); `ACTIVE | SUSPENDED` →
   `PENDING_DELETION` (operator, reason and the typed account name); `PENDING_DELETION` → back to the status it left
   (operator cancels) or → `DELETED` after 30 days (ADR M15-0002). Every other move is `409 INVALID_TRANSITION`.
   The transition table lives in `@canopy/contracts` (`ACCOUNT_TRANSITIONS`) so the API, the job and the console agree.
4. **What each status allows.** `TRIAL` and `ACTIVE`: everything. `PROVISIONING`: only accepting the owner invite.
   `SUSPENDED` and `PENDING_DELETION`: account admins may sign in, see `/me`, sign out and download the account export;
   every other request answers `403 ACCOUNT_SUSPENDED`, and every other person's sign-in is refused with the same code
   ("Your account is paused. Contact PlanetPulse."). Jobs (instance generation, reminders, digests) skip accounts not in
   `TRIAL | ACTIVE`. `DELETED`: nothing. M5 checks status in the request context on every request, so a suspension takes
   effect on the next request without ending sessions.
5. **Plans are data.** Table `plan` (`code`, `name`, `limits` with `companies`, `units`, `users`, `storageBytes`, each a
   number or null for unlimited, and `features` text[]), plus `account_override` per account. Seeded placeholders:
   `STARTER` 1 / 3 / 25 / 10 GB, `BUSINESS` 5 / 25 / 150 / 100 GB, `ENTERPRISE` and `CONSULTANCY` unlimited. Prices are
   not stored. Entitlements are one function, `entitlements(account)` = plan limits overlaid with overrides. Creating a
   company, unit or invite over a limit answers `403 PLAN_LIMIT_REACHED` with `details { limit, max, used }`; nothing is
   removed when a plan shrinks. "Users" counts people `ACTIVE` or `INVITED` with a live membership, support people excluded.
6. **Billing is offline in v1.** The operator records `subscription` periods (plan, start and end dates, amount in paise,
   invoice number, paid date). The console lists renewals due in 30 days. No payments in the app.
7. **Platform tables sit outside tenants.** `plan`, `subscription`, `account_override`, `usage_snapshot`,
   `platform_operator`, `operator_credential`, `operator_session`, `operator_audit_event` have no `firm_id` RLS and **no
   grant to `canopy_app`**. The app reads its own account only through `app_account()` (`SECURITY DEFINER`, keyed by
   `app.firm_id`), which returns kind, status, plan code, trial end and effective limits.
8. **Operator database role.** `canopy_operator` (no `BYPASSRLS`, no login in tests except through its own pool) may
   insert firms through `platform_create_account(...)` (`SECURITY DEFINER`: inserts the firm, its default settings and,
   for an enterprise, its client, in one transaction), update a firm's `status`, `plan_code`, `trial_ends_on`,
   `onboarded_at` and `name`, and read and write the platform tables. It has **no SELECT on any client-data table**; usage
   counts come from `platform_usage(firm_id)` (`SECURITY DEFINER`, returns counts only). An isolation test proves the
   operator role reads zero client rows.
9. **Operator sign-in is separate.** Routes live under `/api/platform/v1` on the API process, mounted only when
   `PLATFORM_ENABLED=true`. They use their own cookie `op_sid` (HttpOnly, Secure, SameSite=Strict, `Path=/api/platform`),
   their own session table and their own CSRF token; the customer `sid` is never accepted there and `op_sid` is never
   accepted anywhere else. Email, password and TOTP are required on every sign-in (reusing M5's scrypt, TOTP and secret
   box); passkeys come later. Sessions last 8 hours, or 30 minutes idle. `PLATFORM_IP_ALLOWLIST` (optional CIDR list)
   refuses other addresses with `404`. Operators are created only by a deploy-time CLI
   (`pnpm --filter @canopy/api platform:add-operator`); no route creates one. The console is a separate Next.js app,
   `apps/operator`, deployed on its own host (for example `admin.planetpulse.life`).
10. **Provisioning.** `POST /api/platform/v1/accounts` takes display name, legal name, GSTIN (optional), kind, plan,
    term or trial end (default 30 days from today), time zone (default Asia/Kolkata), FY start month (default April),
    and the owner's name and email. One transaction: the firm in `PROVISIONING`, its default client for an enterprise,
    the owner as an `INVITED` person with a `FIRM_ADMIN` invite (M5's invite path, link valid 72 hours, resendable by the
    operator), the master obligation library copy (M6), `ACCOUNT_CREATE` and `OWNER_INVITE_SEND` operator audit events,
    and the `account.created` and `person.invited` outbox events. MFA enrolment is required at first sign-in for account
    admins, as today.
11. **Support access, not a back door.** An account admin grants PlanetPulse support access for 1 to 30 days (default 7),
    `READ_ONLY` or `ADMIN`, from the account's settings, and can revoke it at any time. The grant creates (or reuses) a
    person in that account named "PlanetPulse support (<operator name>)" with status `ACTIVE`, and memberships with
    `expires_at` = the grant end: `ADMIN` is one `FIRM_ADMIN` membership; `READ_ONLY` is one `VIEWER` membership per
    client at grant time. From the console, the operator opens a support session, which mints a normal customer-app
    session for that person, valid until the earlier of 2 hours and the grant end, with MFA marked satisfied because the
    operator passed MFA in the console. Every action is audited in the account's own trail as that person. The grant,
    revoke and each support session also write `SUPPORT_ACCESS_START` / `SUPPORT_ACCESS_END` operator events. Without a
    live grant the console has no path to client data.
12. **Operator audit.** `operator_audit_event` is append-only (INSERT and SELECT only): operator id (null for the
    system), action, account id, before, after, reason, at, request id, IP. Actions: `OPERATOR_LOGIN`, `ACCOUNT_CREATE`,
    `OWNER_INVITE_SEND`, `ACCOUNT_STATUS_CHANGE`, `PLAN_CHANGE`, `OVERRIDE_CHANGE`, `SUBSCRIPTION_RECORD`,
    `ACCOUNT_DELETE_REQUEST`, `ACCOUNT_DELETE_CANCEL`, `ACCOUNT_PURGE`, `SUPPORT_ACCESS_START`, `SUPPORT_ACCESS_END`.
    Suspend, resume, plan change and delete need a typed reason (`422 REASON_REQUIRED`). Every operator action that changes
    an account is also written to that account's `audit_event` with the new actor kind `OPERATOR` (`actor_id` null) and
    entity type `account`, so the customer sees "PlanetPulse paused this account on 12 Oct 2026: unpaid invoice". The
    console exports operator audit to Excel.
13. **Contracts (M0, additive, minor bump).** `AccountKind`, `AccountStatus`, `ACCOUNT_TRANSITIONS`, `PlanLimits`,
    `Plan`, `Entitlements`, `Subscription`, `UsageSnapshot`, `OperatorAuditAction`, `OperatorAuditEvent`,
    `SupportGrant`, `Account` (the operator's view of a firm); `Firm` gains `kind`, `status`, `planCode`, `trialEndsOn`;
    `Me` gains `account { kind, status, trialEndsOn }`; error codes `ACCOUNT_SUSPENDED` (403) and `PLAN_LIMIT_REACHED`
    (403); `AuditActorKind` gains `OPERATOR` and `EntityType` gains `account`; customer routes `GET /account`
    (plan, limits, usage; any account admin), `GET|POST /account/support-grants`, `POST /account/support-grants/{id}/revoke`;
    the operator table `PLATFORM_ENDPOINTS` under `/api/platform/v1`, kept out of the customer OpenAPI document and
    published as `openapi.platform.json`; events `account.created`, `account.status_changed`, `account.plan_changed`,
    `support_access.granted`, `support_access.revoked`, with event actor `{ kind: "OPERATOR"; operatorId }` added.
14. **No sign-up.** No route creates a firm except `POST /api/platform/v1/accounts`. M5 adds a test that lists every
    customer route and asserts none inserts a firm; M14's security review re-checks it.

## Defaults Shyam can change at any time

These are the plan's §10 open questions. Each is data or one constant, so changing one needs no new ADR.

| Question | Default | Where it lives |
|---|---|---|
| Plan names, limits, prices | Placeholders in decision 5; no prices stored | `plan` rows (operator console) |
| Trial length | 30 days | `DEFAULT_TRIAL_DAYS` in contracts; per account at creation |
| Export while paused | Allowed: account admins of a `SUSPENDED` or `PENDING_DELETION` account can download it | decision 4 |
| Operators besides Shyam | Shyam only; the model supports more | `platform:add-operator` CLI |
| Support grant length | 7 days default, 30 maximum | `SUPPORT_GRANT_DEFAULT_DAYS`, `SUPPORT_GRANT_MAX_DAYS` |

## Order of work

1. This ADR and M15-0002.
2. M0 contracts (decision 13).
3. M3 migration: `firm` columns (add nullable, backfill, constrain), platform tables, `canopy_operator`, `app_account()`,
   `platform_create_account()`, `platform_usage()`, purge function, isolation tests.
4. M5: account status in the request context and at sign-in, support-access grants and sessions, the no-sign-up test.
5. M15: operator auth, operator API, provisioning, lifecycle; then the console.
6. In parallel after 2-4: M6 entitlement checks and library copy on provisioning; M9 skip non-active accounts, nightly
   usage snapshot, trial-ending and renewal reminders, trial expiry and purge jobs; M10 account export; M11 single-client
   shell, paused and trial banners, "Account" wording; M13 setup checklist, plan and usage page, support-access screen.
7. M14: operator creates account → owner accepts → invites a user → hits a plan limit → suspend → resume.

## Consequences

- Customer data stays behind the same RLS wall; the operator gets a second wall (no grants) on top.
- Adding an account status or plan field is a contracts minor bump and an M3 migration.
- PlanetPulse staff can only reach customer data while the customer allows it, and the customer's audit trail shows it.
