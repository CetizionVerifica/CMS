# Canopy: modular build plan (one module = one parallel thread)

This replaces the sequential phases in `PLAN.md` §6. Each module below is a self-contained brief that one thread can
build on its own. Modules talk to each other only through the **contracts** listed under "Provides" and "Uses".
No code is written until Shyam says to start a wave.

## How parallel threads stay out of each other's way

1. **Contracts first.** M0 writes the shared contracts (domain types, enums, API spec, events, error codes). Every other module builds against those, not against another module's internals.
2. **One owner per path.** A thread only changes the paths its module owns. Need a change elsewhere? Ask that module's thread (via the coordinator); never edit it directly.
3. **Contract changes go through M0.** A thread that needs a new field or endpoint files a change request with M0; M0 updates the contract and announces the new version. Breaking changes need sign-off from every module that uses the contract.
4. **Build against mocks.** Frontend modules use a mock API generated from the M0 OpenAPI spec; backend modules use fixture data from M0. Nobody waits for a real dependency to start.
5. **Contract tests at the seams.** Each provider ships tests proving it meets the contract; each consumer ships tests against the mock. Integration (M14) runs both together.
6. **Done = the module's acceptance list is green** plus the root `CLAUDE.md` definition of done.

## Waves (what can run at the same time)

| Wave | Modules in parallel | Starts when |
|---|---|---|
| 0 | M0 Contracts · M1 Foundations · M2 Design system | Shyam says go |
| 1 | M3 Database · M4 Engine · M8 Importer · M11 Web shell | M0 contracts v1 published (M1 repo skeleton ready) |
| 2 | M5 Auth · M6 Library & entities API · M7 Workflow & evidence API · M9 Jobs & notifications · M12 Web register & approvals | M3 schema merged (M5 first, M6/M7 can stub auth via the contract) |
| 3 | M10 Dashboards & reports API · M13 Web overview, import, setup, reports | M4 + M7 merged |
| 4 | M14 Integration, QA & hardening | All modules merged |
| 5 | M15 Platform operator | M5, M6 and M9 merged |

Up to 5 threads run at once in waves 1 and 2.

The start condition for each module is its `needs` list in `tooling/modules.json`, read by
`node tooling/scripts/plan-wave.mjs`. Where the table and the diagram differ: M6 and M7 need only M3 (M7 also M4) and
stub auth through the M0 contract, as the table allows, instead of waiting for M5 as the diagram draws; M12 needs only
M11, as the diagram and "Uses" say (it builds on the mock API, not M3); M8 needs only M0, because its parse, map and
clean steps start alongside M4 and its commit step is added after M3 merges. "M0 merged" means M0's first PR (v1
domain types, enums and Zod schemas). The coordinator keeps to the 5-thread cap when starting what the planner lists.

```
M0 ─┬─ M3 ─┬─ M5 ─┬─ M6 ───────────┐
    │      │      ├─ M7 ─┬─ M10 ───┤
    ├─ M4 ─┼──────┘      │         ├─ M14
    │      └─ M9         │         │
    ├─ M8 (parse/clean now, commit after M3)
M2 ─┴─ M11 ─┬─ M12 (mock API) ─────┤
            └─ M13 (mock API) ─────┘
M1 underpins all (repo, CI)
```

## Module summary

| ID | Module | Owns (paths) | Uses | Provides |
|---|---|---|---|---|
| M0 | Contracts & domain spec | `packages/contracts`, `docs/contracts` | Excel analysis | Domain types, enums, Zod schemas, OpenAPI spec, event catalogue, error codes, fixtures, mock server |
| M1 | Repo foundations & CI | root config, `.github`, `docker`, `tooling` | — | Monorepo, scripts, CI pipeline, local Postgres, preview deploys |
| M2 | Design system | `packages/ui` | Canopy mockup | Tokens, Tailwind preset, components, status language |
| M3 | Database & tenancy | `packages/db` | M0 types | Schema, migrations, RLS, `withTenant`, repositories, seed hook |
| M4 | Compliance engine | `packages/engine` | M0 types | Recurrence, `generateInstances`, `inferRule`, `deriveStatus`, scores, `planNotifications` |
| M5 | Auth, roles & permissions | `apps/api/src/auth` | M0, M3 | Sessions, invites, MFA, `can(actor, action, resource)`, request context |
| M6 | Library & entities API | `apps/api/src/modules/{clients,entities,people,library,assignments}` | M0, M3, M5 | CRUD endpoints for firm, clients, units, people, Acts, obligations, assignments |
| M7 | Workflow, evidence & audit API | `apps/api/src/modules/{instances,evidence,approvals,audit}` | M0, M3, M4, M5 | Instance state machine, evidence upload/scan, comments, audit trail endpoints |
| M8 | Excel importer | `packages/importer`, `apps/api/src/modules/imports` | M0, M4, M3 (commit only) | Parse, map, clean, dry run, commit, mapping templates |
| M9 | Jobs & notifications | `apps/api/src/jobs`, `packages/notifications` | M0, M3, M4 | Instance generation job, reminders and escalations, email templates, digests |
| M10 | Dashboards & reports API | `apps/api/src/modules/{dashboard,reports}` | M0, M4, M7 | KPI and breakdown endpoints, Excel export, PDF compliance certificate |
| M11 | Web shell & navigation | `apps/web/app/{layout,page,not-found,global-error}.tsx`, `apps/web/app/globals.css`, app icons (`apps/web/app/{icon.svg,apple-icon.png}`, `apps/web/public`), `apps/web/app/(auth)`, the shell frame in `apps/web/app/(shell)` (its `layout`, `loading`, `error` and `[...stub]`, and the same under `(shell)/c/[clientId]`, plus that segment's `page`), `apps/web/lib`, `apps/web/{next.config.ts,postcss.config.mjs,proxy.ts,tsconfig.json,vitest.config.mjs}` | M0 mock, M2 | Layout, sidebar, client switcher, period picker, auth pages, API client |
| M12 | Web register & approvals | `apps/web/app/(shell)/c/[clientId]/{register,approvals,calendar,evidence}` | M0 mock, M2, M11 | Register grid, instance drawer, approvals inbox, calendar, evidence vault |
| M13 | Web overview, import, setup, reports | `apps/web/app/(shell)/portfolio`, `apps/web/app/(shell)/c/[clientId]/{overview,import,setup,reports,audit}`, `apps/web/app/(shell)/library` | M0 mock, M2, M11 | Portfolio, client overview, import wizard, setup screens, reports, library screens |
| M14 | Integration, QA & hardening | `e2e/`, `docs/security`, perf scripts | everything | E2E suite, isolation and security review, accessibility audit, load test, pilot runbook |
| M15 | Platform operator | `apps/api/src/platform`, `apps/operator` | M0, M3, M5, M6, M9 | Operator console and API for company accounts: the operator creates an account and its first admin, and renews, suspends or closes it |

---

## Module briefs

Each brief is what a thread receives. Read root `CLAUDE.md` and the listed area CLAUDE.md first.

### M0 · Contracts & domain spec
- **Goal:** one source of truth for shapes every other module uses.
- **Read:** `docs/requirements/excel-analysis.md`, `packages/db/CLAUDE.md`, `packages/engine/CLAUDE.md`, `apps/api/CLAUDE.md`.
- **Deliver:**
  - Domain types and enums: Firm, Client, Company, Unit, Location, Person, Membership, Department, Act, Category, Obligation, RecurrenceRule, Assignment, ComplianceInstance, WorkflowState, DerivedStatus, Criticality, Evidence, Comment, AuditEvent, ImportBatch/Row.
  - Zod schemas for each API request and response; OpenAPI 3.1 spec generated from them.
  - Endpoint list per module (M5, M6, M7, M8, M10) with role permissions per endpoint.
  - Event catalogue (`instance.submitted`, `instance.approved`, `assignment.changed`, `import.committed`, …) with payloads.
  - Error codes, pagination and filter conventions.
  - Fixtures: the sample register as typed JSON (119 obligations, 424 instances), plus a second synthetic firm.
  - Mock API server from the spec and fixtures (used by M11-M13).
- **Accept:** spec lints clean; mock server serves every endpoint; each consumer module owner reviewed its part; versioned `v1`.

### M1 · Repo foundations & CI
- **Goal:** a repo every thread can clone and run on day one.
- **Deliver:** pnpm + Turborepo workspace with empty packages for every module path above; TypeScript, ESLint, Prettier configs; Vitest and Playwright set up; docker compose with Postgres 16 and S3-compatible storage; CI running lint, typecheck, unit, e2e on every PR; CODEOWNERS mapping paths to modules; preview deploy per PR.
- **Accept:** `pnpm install && pnpm dev && pnpm test` works on a clean machine; CI blocks merge on failure; CODEOWNERS matches the "Owns" column.

### M2 · Design system (Canopy)
- **Read:** `packages/ui/CLAUDE.md`, Canopy option in the design artifact.
- **Deliver:** tokens and Tailwind preset; components in the order listed in `packages/ui/CLAUDE.md`; a demo page per component; status and criticality language.
- **Uses:** nothing from other modules, so it starts in wave 0.
- **Accept:** every component keyboard-tested and axe-clean; demo of the Canopy overview composed purely from components matches the mockup.

### M3 · Database & tenancy
- **Read:** `packages/db/CLAUDE.md`.
- **Deliver:** schema and migrations for all v1 tables; RLS policies; `withTenant`; typed repository functions per aggregate (the only DB access other modules use); seed hook that M8 fills.
- **Accept:** isolation test per table (two firms); migrations apply on empty and populated DB; repository signatures match M0 types.

### M4 · Compliance engine
- **Read:** `packages/engine/CLAUDE.md`.
- **Deliver:** LocalDate helpers, RecurrenceRule evaluation, `generateInstances`, `inferRule`, `deriveStatus`, score and breakdown functions, `planNotifications`, `ENGINE_VERSION`.
- **Uses:** M0 types only; zero I/O, so it is fully parallel with M3.
- **Accept:** golden test regenerates the sample's FY 2022-23 due dates from inferred rules; boundary-date tests; 100% branch coverage on status and score.

### M5 · Auth, roles & permissions
- **Read:** `apps/api/CLAUDE.md` (roles section).
- **Deliver:** login, magic link, invites (people imported from Excel are unclaimed until invited), MFA for firm roles, sessions, request context (actor, firm, client scope), `can()` policy table.
- **Provides to M6/M7/M8/M10:** a request context and `can()` check with the M0 signature. Until merged, those modules use the M0 stub.
- **Accept:** policy unit tests per role × action; session and invite flows tested; no route reachable without context.

### M6 · Library & entities API
- **Deliver:** endpoints for clients, companies, units, locations, departments, people and memberships; Acts, categories, obligations (with recurrence rule validated by M4); assignments with applicability and NA reason; alias management.
- **Accept:** endpoints match the OpenAPI spec (contract tests); every write audited; role tests per endpoint.

### M7 · Workflow, evidence & audit API
- **Read:** `apps/api/CLAUDE.md` (workflow section).
- **Deliver:** instance list and detail with filters matching the register; state machine (submit, approve, send back, request NA, reopen) with optimistic concurrency; bulk approve; comments; presigned evidence upload, scan status, signed downloads; audit trail endpoints.
- **Accept:** every transition and every invalid transition tested; derived status always from M4; audit event per change.

### M8 · Excel importer
- **Read:** `packages/importer/CLAUDE.md`, `docs/requirements/excel-analysis.md`.
- **Deliver:** parser, header auto-mapping, cleaning proposals, review model, dry-run report, commit through M3 repositories, saved mapping templates, import API endpoints.
- **Parallel note:** parse, map, clean and dry run need only M0 and M4, so they start in wave 1; commit plugs in once M3 merges.
- **Accept:** golden counts from excel-analysis.md §5; idempotent re-import; round trip with M10 export.

### M9 · Jobs & notifications
- **Deliver:** pg-boss setup; nightly `generate-instances` (current and next FY); daily reminders and escalations using `planNotifications`; weekly consultant digest; email templates in Canopy style; send log with dedupe.
- **Accept:** jobs idempotent; time-zone tests for Asia/Kolkata; no reminder for complied or NA items.

### M10 · Dashboards & reports API
- **Deliver:** portfolio KPIs per client; client overview KPIs and breakdowns (department, Act, criticality, unit, owner) with instance ids; calendar feed; Excel register export (re-importable); PDF compliance certificate per unit and period; Act-wise and department-wise reports.
- **Accept:** each KPI equals the matching filtered instance count from M7 (cross-check tests); export re-imports with no changes.

### M11 · Web shell & navigation
- **Read:** `apps/web/CLAUDE.md`, `packages/ui/CLAUDE.md`.
- **Deliver:** Canopy app shell with sidebar groups, client switcher, period picker (URL state), search box placeholder, auth pages, typed API client pointed at the M0 mock, loading/empty/error/no-permission page patterns.
- **Accept:** navigates every route stub; responsive at 1280 and 375; keyboard-only path through the shell.

### M12 · Web register & approvals
- **Deliver:** register grid (Excel-matching columns, filters in URL, saved views, bulk actions, export), instance drawer with role-aware actions, approvals inbox with shortcuts, calendar, evidence vault.
- **Accept:** smooth at 10,000 mock rows; e2e against the mock for submit with evidence, approve, send back; axe-clean.

### M13 · Web overview, import, setup, reports
- **Deliver:** consultant portfolio, client overview dashboard (every number links to the filtered register), import wizard (upload, map, review, dry run, commit, resume), setup screens (entities, people, departments, reminders), library screens, reports and audit pages.
- **Accept:** e2e for importing the sample file against the mock; overview matches the Canopy mockup layout; axe-clean.

### M14 · Integration, QA & hardening
- **Deliver:** switch web from mock to real API; full Playwright suite on seeded data; cross-tenant penetration checks; security review (auth, uploads, signed URLs, logging of personal data); WCAG 2.2 AA audit; load test at 10,000 instances per client; backup and restore drill; pilot onboarding runbook.
- **Accept:** all suites green on the integrated build; no P0/P1 findings open; pilot client imported from their own register.

---

## Starting threads

When Shyam says go, the coordinator starts one thread per module in the current wave, each briefed with:
its section above, the root `CLAUDE.md`, the area CLAUDE.md for its paths, and the rule that it only edits paths it owns.
A repository needs to be attached before M1 starts; M0 and M2 can begin as specs and documents under `/mnt/project-files/canopy-plan/` without one.
