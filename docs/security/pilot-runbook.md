# Pilot onboarding runbook (M14)

The steps from an empty production deployment to a pilot customer working in PlanetPulse Compliance on their own
register. Each step names who does it and what to check before the next. Customers, their people and their files are
never named in this repo; keep the pilot's own notes outside it.

## 0. Before the first customer (PlanetPulse)

1. Work through the deploy checklist in [`review.md`](review.md) (items 1 to 14). In particular: SMTP works before
   anyone is invited (invites, sign-in links and the MFA notice are email), ClamAV answers (evidence cannot be
   downloaded until it is scanned), and `TRUST_PROXY` lists only the web servers and the load balancer.
2. Backups are on and a restore has been tried once by hand ([`backup-restore.md`](backup-restore.md)).
3. Create the platform operator on the API server, the password on stdin:
   `pnpm --filter @canopy/api platform:add-operator --email <operator email> --name "<name>"`. Add the printed
   `otpauth://` URI to an authenticator app, then destroy the terminal scrollback; never paste it anywhere.
4. Sign in to the operator console from an address in `PLATFORM_IP_ALLOWLIST` and check **Plans** shows the plans
   and limits you sell.
5. Smoke test with a throwaway account: create it (step 1 below), accept the invite into a test mailbox, add a client,
   import the anonymised sample register (`packages/importer/fixtures/sample-register-anonymised.xlsx`: 422 instances,
   119 obligations), then close the account in the console and cancel the closing.

## 1. Create the customer's account (operator, console)

**Accounts → New account.** Display and legal name, **Kind** (`Enterprise` for a company buying for itself, which
gets its one client made for it; `Consultancy` for a firm managing many clients), the plan, GSTIN, time zone and
financial year start, trial or paid, and the owner's name and email.

Check: the account shows **Provisioning**, then **Trial** or **Active** once the owner accepts. The owner's invite
email arrives (the console's **Resend owner invite** sends a fresh 72-hour link and stops the old one).

## 2. The owner opens the account (customer's account admin)

The owner follows the emailed link, sets a password and sets up sign-in codes in the same step: account admins and
consultants always sign in with a code (security review F14). They get an email whenever codes are set up or reset.

Check: the owner reaches the app; **Account** shows the plan, limits and usage.

## 3. Set up each client (account admin or consultant)

1. **Consultancy accounts:** **Portfolio → Add a client**, by the customer group's name. Enterprise accounts already
   have theirs.
2. **Setup → Entities:** the companies and units (plants, sites, offices) with their locations.
3. **Setup → People:** the client admin, approvers and owners, with their emails. People named in the register are
   matched by name on import, so add the main ones first and the import fills in the rest as unclaimed people.
4. **Setup → Departments:** the departments the register uses, with other spellings, so the import maps them.
5. **Setup → Reminders:** when owners and approvers are reminded, and the consultants' weekly digest.
6. Giving a person an email in **People** invites them. Client users (owner, approver, viewer) sign in with a
   password or an emailed link, no code needed.

## 4. Import the customer's register (consultant)

**Import:** upload the customer's Excel register, map its columns, review each proposed cleaning (nothing is changed
without being shown: root CLAUDE.md rule 5), dry run, then commit. An interrupted import resumes from where it
stopped.

Check against the customer's own file before going live:

- The dry run's instance and obligation counts match the rows and distinct compliance IDs in the file.
- **Overview** for the current financial year: every number opens the register on exactly those rows.
- Spot-check five instances in the register drawer against the file: obligation, unit, department, owner, approver,
  due date.
- Owners and approvers in the register are the right people, not unclaimed duplicates (merge them in **People**).

## 5. Go live (account admin, with PlanetPulse)

1. Owners submit with evidence, approvers approve or send back from **Approvals**; walk one of each through with the
   customer.
2. Agree who reads **Reports** and the **Audit trail**, and who can download the register and certificates.
3. If PlanetPulse support needs to look, the account admin grants it on **Account → PlanetPulse support access**
   (read-only by default, for the days they choose) and can end it at any time; support sessions are on the
   customer's audit trail.
4. The operator marks the account **onboarded** in the console.

## 6. During the pilot (PlanetPulse)

- Watch the API and job logs daily for failed jobs (reminders, evidence scan, nightly purge, account jobs). Logs
  carry counts and ids only, never names, files or links.
- The operator console's **Renewals** lists trials and subscriptions ending; the account admins get emails 30 and 7
  days before.
- Collect the customer's feedback against `PLAN.md`; record decisions as ADRs.

## 7. If the pilot ends

The operator requests deletion in the console (typing the account's name). For 30 days only the account admins can
sign in, and only to **Account → Download your data**: one zip per client with the whole register and the clean
evidence files. The operator can cancel within the 30 days. After that the nightly purge deletes the account's rows,
audit trail and files from the live system; the operator audit keeps the record that it happened. Copies remain in
the backups until they age out, up to 35 days later ([`backup-restore.md`](backup-restore.md)), and a restore from
one is followed by the purge again.
