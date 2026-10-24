# Security and integration review (M14)

What M14 checked on the integrated build (the built web app, the real API, Postgres 16 and S3-compatible storage),
what it found, and where each finding went. The checks that can run on every build are in `e2e/integrated`
(`pnpm --filter @canopy/e2e test:integrated`, see "Running the integrated suite" below). Findings outside M14's paths
were sent as patches to the owning module; the table says where each one stands.

Severity: **P0** stops a pilot (data exposure or a core journey broken), **P1** must be fixed before a pilot,
**P2** before general availability, **P3** hardening.

## Findings

| ID  | Sev | Area                     | Finding                                                                                                                                                                                                                                                                                                                                                                  | Owner         | Status                       |
| --- | --- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ---------------------------- |
| F1  | P0  | Sign-in                  | No client user (owner, approver, client admin, viewer) could get past sign-in: the web sent every session whose `mfa.satisfied` was false to the code step, and the API (rightly) leaves it false for roles that never need MFA. The web mock said `true`, which hid it.                                                                                                     | M11           | Fixed in #135                |
| F2  | P0  | Uploads                  | Every browser upload to S3 failed. The AWS SDK signs a CRC32 of the empty body into presigned PUT URLs, so storage rejects the real file as a checksum mismatch. Import wizard and evidence upload both broke.                                                                                                                                                           | M7, M8        | Fixed in #133 and #131       |
| F3  | P1  | Evidence                 | The production wiring never mounted M7's evidence routes (5 of 109 contract endpoints answered 404).                                                                                                                                                                                                                                                                    | CI thread     | Fixed in #126                |
| F4  | P1  | Rate limits              | The API limits requests per client IP, but in production every call comes from the web server, so all users shared one budget: 300 requests a minute for the whole product and 10 sign-ins a minute. Fixed by the web passing on `X-Forwarded-For` and the API trusting it only from the web tier (`TRUST_PROXY`, see the deploy checklist).                         | M11           | Fix in #136                  |
| F5  | P2  | Deploy                   | The app's database login needs `CREATE` on the database: M9's job runner (pg-boss) creates its own `pgboss` schema at start, so the API does not boot with a login that has only the `canopy_app` grants.                                                                                                                                                                | M9, deploy    | Fixed in #153; deploy item 2 |
| F6  | P2  | Seed                     | `pnpm db:seed` ran no seed hooks, so the sample register was never seeded (packages/db rule 10).                                                                                                                                                                                                                                                                         | M8            | Fixed in #131                |
| F7  | P1  | Performance, rate limits | Each server render of the shell calls `GET /me` and, for firm users, `GET /portfolio` (scores for every client), and link prefetching renders the shell many times per page. One consultant's import journey made about 400 API calls in 20 seconds (198 `/me`, 121 `/portfolio`), more than the per-visitor limit allows, and `/portfolio` will be slow at 10,000 instances per client. | M11           | Fixed in #147                |
| F8  | P1  | Evidence                 | Nothing scans uploaded evidence, so every file stays `PENDING`: it cannot be downloaded (`EVIDENCE_NOT_READY`) and an obligation that requires evidence can never be submitted. Needs a scan job and a choice of scanner.                                                                                                                                              | M9, Shyam     | Fixed in #146 (ClamAV)       |
| F9  | P2  | API contract             | `GET /clients/{clientId}/instances` ignores `?count=true` (api-conventions.md §3), so callers cannot get a total without paging through every row.                                                                                                                                                                                                                       | M7            | Fixed in #142                |
| F10 | P3  | Web headers              | The web app sends `X-Frame-Options`, `nosniff` and a referrer policy, but no Content-Security-Policy. HSTS is left to the load balancer.                                                                                                                                                                                                                                | M11           | Reported                     |
| F11 | P3  | Logging                  | Unhandled API errors are logged with the full error object. A Postgres error's `detail` can quote row values (for example an email in a unique violation), which root rule 6 keeps out of logs.                                                                                                                                                                          | M5            | Fixed in #141                |
| F12 | P1  | Sign-in                  | The web app has no MFA enrolment screen. A firm admin or consultant who has not enrolled yet is sent to the code step with no way to get a code, so a new firm user can never finish signing in. The API's enrolment (`/auth/mfa/enroll`) works; the integrated run enrols through it.                                                                         | M11           | Fixed in #158                |
| F13 | P1  | API lists                | Every M6 list (clients, companies, units, locations, departments, people, Acts, categories, obligations, assignments) answers 500 to `limit=200`, the largest page the contract allows: the API asks the database for one row more than the page to find the next page, and the repository refuses 201. The library's obligations page asks for every Act this way, so it fails to load. | M6            | Fixed in #154                |
| F14 | P2  | Sign-in                  | A firm user's first MFA enrolment is trust-on-first-use: until they enrol, anyone with their password can enrol their own authenticator and keep it. Mitigation: firm-role invite acceptance enrols MFA in the same step, while the invite token is fresh, so no session ever exists with a password and no MFA; the operator-created first admin goes through the same invite; email the person whenever MFA is enrolled or reset. | M5, M11       | Patch being drafted          |

## What was checked and holds

Each line is a test in `e2e/integrated` unless it says otherwise.

**Tenant isolation**

- Every contract endpoint that names a record in its path or body, called by firm B's firm admin and by its client
  admin with firm A's ids (client, instance, evidence, export, import, invite, company, unit, department, assignment,
  person, membership, Act, category, obligation): reads answer 404 or 403; writes answer exactly as they do for an id
  that does not exist. Every such write is sent with a valid body (checked against the contract) and firm A's current
  versions, and bodies that name records name firm A's (merge sources, a unit's company and location, an assignment's
  owner and approver, the clients an obligation is pushed to), so only the tenant check stands in their way. Every firm-wide list holds firm B's records only, and no answer contains firm
  A's names. Endpoints left out are listed with a reason, and a new endpoint fails the check until it is placed;
  contract endpoints the API does not serve yet (the M15 account routes) are listed too, and the check fails the day
  one answers. (`04-security.spec.ts`)
- Row-level security, as the app's own database login (not a superuser, no `BYPASSRLS`): set to firm B, or to no
  tenant, it sees none of firm A's rows in 13 tables, from `firm` to `auth_session`.
- The API serves through a plain member of `canopy_app` with `NODE_ENV=production`, so `createDatabase` would have
  refused a privileged login.
- A consultant's portfolio lists their firm's client only. (`03-dashboards-reports.spec.ts`)

**Authentication and sessions**

- Every non-public endpoint answers 401 (reads) or 401/403 (writes) with no session.
- Writes need the CSRF token from `/me`.
- The session cookie is `HttpOnly`, `Secure` and `SameSite=Lax`; signing out ends the session on the server, so a
  replayed cookie gets 401.
- A wrong password and an unknown email get the same answer.
- Firm roles enrol in TOTP MFA through the API (F12) and then pass the code step at every sign-in (all journeys sign
  in through the real login page, which is checked with axe).

**Roles**

- An owner cannot approve; a viewer cannot submit but can read; reports and exports are not an owner's.
- A second submit with a stale version is refused (409), not applied twice. (`02-workflow.spec.ts`)

**Uploads and downloads**

- Evidence types outside the allow-list (HTML, SVG, executables, a PDF name declared as HTML) and files over 25 MB get
  no upload link.
- Upload links expire in 5 minutes and bind the declared content type: storage refuses a PUT with another type.
- Export download links expire in 5 minutes; the file is a real workbook.
- The evidence scan (F8) runs end to end against a stand-in clamd (`e2e/integrated/fake-clamd.ts`, port 4110) that
  reports EICAR's test string: a clean upload becomes `CLEAN` and downloads through a 5-minute link as the same bytes;
  a file carrying EICAR under an accepted name and type becomes `INFECTED` and, like a file still `PENDING`, is never
  handed out. Both verdicts and the download are on the instance's audit trail. The vault never returns storage keys,
  and firm B's admin reaches neither the vault nor the file.

**Integration**

- The import wizard loads the anonymised sample register end to end: 422 instances and 119 obligations (dry run and library), the golden
  counts in `docs/requirements/excel-analysis.md` §5, and the owner and approver named in it are matched to the
  seeded people. (`01-import.spec.ts`)
- Owner submits, approver bulk-approves from the register, and the instance audit trail shows import, submission and
  approval in order. (`02-workflow.spec.ts`)
- Every overview count is exactly the register's rows for that status, and they add up to the whole register; the
  overdue number on the page opens a register showing the same count. (`03-dashboards-reports.spec.ts`)
- Act-wise, department-wise and overdue reports answer for a client admin.
- Every client and firm list answers a full page of 200, the contract's largest (`06-lists.spec.ts`).
- One consultant browsing the main pages at an ordinary pace from one address is never refused (F7), while a flood
  of anonymous requests from one address gets `429 RATE_LIMITED` once it passes the 300-a-minute budget and another
  address is still served. A caller outside `TRUST_PROXY` cannot dodge the budget by naming a new address in
  `X-Forwarded-For` on each request: the API counts the address the request came from. (`05-shell-load.spec.ts`)
- M12's screens (`07-instance-screens.spec.ts`): the owner attaches evidence in the instance drawer, waits for the
  scan to pass it, opens it from storage through a 5-minute link, comments and submits; the approver reads the
  evidence and comment in the approvals inbox's drawer and approves, and sends another back from the list with a
  reason that lands on the audit trail; the evidence vault lists the client's files, opens a clean one and shows the
  flagged one as blocked with no way to open it; the calendar's count for a month equals the register's for the same
  dates, and a day and the list view open the instance. Each screen is checked with axe (the drawer on its own, as
  it hides the page behind it).

Not yet covered: the setup, reports and audit pages (M13), and company accounts (M15). Some journeys take a
step through the API when another journey covers its screen (for example the submit in `02-workflow.spec.ts`) and say
so in a comment.

## Running the integrated suite

```
pnpm build
DATABASE_URL=postgres://canopy:canopy@localhost:5432/canopy \
S3_ENDPOINT=http://localhost:9000 S3_BUCKET=canopy-evidence \
S3_ACCESS_KEY_ID=canopy S3_SECRET_ACCESS_KEY=canopy-secret \
pnpm --filter @canopy/e2e test:integrated
```

`pnpm db:up` starts Postgres and SeaweedFS. The run drops and recreates a `canopy_e2e` database on the same server,
creates the app login `canopy_e2e_app` and the jobs login `canopy_e2e_jobs`, seeds two firms with one client each and an account per role
(`e2e/integrated/stack.ts`), and starts the API on port 4100 (with its jobs, the evidence scan included), the web
app on 3100 and the stand-in clamd on 4110. Set `PLAYWRIGHT_CHROMIUM_PATH`
to use a Chromium that is already installed.

## Deploy checklist (pilot)

What a deployment must set for the findings above to stay closed. Never put real values in the repo.

1. `NODE_ENV=production` on the API and the web app.
2. Database: migrations run as the owner. The API connects as a separate login that is a member of `canopy_app`,
   is not a superuser, has no `BYPASSRLS`, owns no tables and has only `CONNECT` on the database. The job runner
   (`JOBS_DATABASE_URL`) connects as a login of its own that is a member of `canopy_jobs` (not of `canopy_app`) and
   starts as it (`ALTER ROLE … SET role = canopy_jobs`), so tenant requests cannot reach the job tables (ADR M3-0004).
3. `AUTH_SECRET_KEY`: 32 random bytes, base64 (`openssl rand -base64 32`).
4. Object storage: a private bucket; `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (and
   `S3_ENDPOINT` for a non-AWS store). The bucket's CORS allows `PUT` and `GET` from the web app's origin only.
5. Client addresses (F4): the API's `TRUST_PROXY` lists the web servers' and the load balancer's addresses or CIDRs,
   never `true` (with `true` the API takes the leftmost `X-Forwarded-For` entry, which a browser controls, and could
   be made to count each request as a new visitor). The load balancer appends the visitor's address to
   `X-Forwarded-For`, and the web servers are reachable only through it, so no browser can talk to them directly
   and pick its own address.
6. Mail: `SMTP_URL` (or `SMTP_HOST`), `MAIL_FROM` and `APP_URL`, or reminders and approval emails never go out.
7. The web app: `CANOPY_API_URL` pointing at the API; never `CANOPY_DEMO_API`. `CANOPY_CSP_CONNECT_SRC`
   (space-separated) includes the object storage's origin: browsers upload evidence and workbooks straight to storage,
   and with it unset the Content-Security-Policy allows only the app's own origin, which blocks every upload.
8. HTTPS everywhere, with HSTS at the load balancer.
9. Evidence scanning (F8): `CLAMAV_HOST` (and `CLAMAV_PORT`) pointing at a clamd whose `StreamMaxLength` is at least
   26M. Without it every file stays unscanned and cannot be downloaded.
10. The operator console (M15, ADR M15-0003), when `PLATFORM_ENABLED=true`: `OPERATOR_DATABASE_URL` is a login of its
    own, a member of `canopy_operator` only (ADR M3-0002); `PLATFORM_IP_ALLOWLIST` lists the addresses the operator
    signs in from (the API refuses to start without it in production); `APP_URL` is the customer app's https origin,
    where support sessions open. The operator is created with `pnpm --filter @canopy/api platform:add-operator`, never
    through a route. The console is built with `OPERATOR_API_URL` set, since Next fixes its rewrite at build time. When
    the load balancer sends `/api/platform` to the console server rather than straight to the API, the API sees the
    console server as its client: `TRUST_PROXY` must list it, or the allowlist checks the console server's address
    instead of the operator's.
