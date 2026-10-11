# Canopy: root CLAUDE.md

Read this file first, then the CLAUDE.md of the area you are changing. Area files add rules; they never relax these.

## What this product is
A multi-client **statutory compliance management** web app for a consultancy. Consultants manage many clients;
client owners and approvers complete legal obligations (labour, EHS, tax, IT laws) with evidence.
Product plan: `PLAN.md`. Module briefs for parallel threads: `MODULES.md`. Requirements source: `docs/requirements/excel-analysis.md` (derived from the client register Excel).
Visual direction: Canopy (light, forest-green sidebar, client switcher). Design rules: `packages/ui/CLAUDE.md`.

## Map
| Path | What | Read before changing |
|---|---|---|
| `apps/web` | Next.js frontend | `apps/web/CLAUDE.md` |
| `apps/api` | Fastify API, auth, roles, workflow | `apps/api/CLAUDE.md` |
| `packages/db` | Postgres schema, Drizzle, RLS, migrations | `packages/db/CLAUDE.md` |
| `packages/engine` | Recurrence, due dates, status, scores (pure TS) | `packages/engine/CLAUDE.md` |
| `packages/importer` | Excel import, mapping, cleaning | `packages/importer/CLAUDE.md` |
| `packages/ui` | Canopy tokens and components | `packages/ui/CLAUDE.md` |
| `packages/contracts` | Shared types, Zod schemas, OpenAPI, fixtures, mock API (M0) | `MODULES.md` M0 |
| `docs/` | Requirements, ADRs | — |

Dependency direction: `web → api client → api → engine, db`; `importer → engine, db`; `ui` depends on nothing in the repo.
`engine` must not import `db`, `api` or any I/O.

## Vocabulary (use these words in code, UI and tests)
- **Obligation**: a requirement derived from an Act (Excel: one Compliance ID). Not "task", not "compliance".
- **Assignment**: an obligation applied to a unit, with department, owner and approver.
- **Instance**: one dated occurrence of an assignment (Excel: one row). Has a due date and a status.
- **Owner** submits, **Approver** approves. **Unit** = plant/site/office. **Client** = the customer organisation group.
- **Firm** = the consultancy tenant. **FY** = Indian financial year, April to March, unless the client overrides it.

## Commands
```
pnpm install
pnpm dev            # web + api + local Postgres (docker compose)
pnpm lint && pnpm typecheck && pnpm test
pnpm test:e2e       # Playwright against seeded data
pnpm db:migrate     # apply migrations
pnpm db:seed        # seeds two firms and the sample client from the Excel fixture
```

## Parallel module rules
- Each thread works on one module from `MODULES.md` and edits only the paths that module owns (CODEOWNERS enforces this).
- Modules depend on each other only through `packages/contracts` (M0). Never import another module's internals.
- Need a contract change? Request it from M0; do not edit `packages/contracts` from another module.
- Build against the M0 mock API and fixtures until the real dependency is merged.
- A module's thread starts only when every module in its `needs` (`tooling/modules.json`) is merged.
  `node tooling/scripts/plan-wave.mjs --merged <ids> --running <ids>` lists the modules that can start now; a tooling
  test fails if two modules that can run at the same time own overlapping paths.
- Shared files (`pnpm-lock.yaml`, `pnpm-workspace.yaml`, app `package.json`, `apps/api/src/server.ts`) are the only
  places parallel PRs can collide. Add all of a module's dependencies in its first PR. On a conflict, merge `main` into
  the branch and regenerate the lockfile with `pnpm install`; never hand-edit it, never rebase a pushed branch.

## Non-negotiables
1. **Tenant isolation.** Every table holding client data has `firm_id` and an RLS policy. Every query runs inside a request-scoped tenant context. A cross-tenant read is a P0 bug; every new table gets an isolation test.
2. **Audit everything that changes compliance state.** Status changes, due-date changes, reassignment, evidence add/remove, NA decisions: write an `AuditEvent` in the same transaction. Never update or delete audit rows.
3. **Compliance logic lives in `packages/engine` only.** No status, due-date or score maths in components, API handlers or SQL views. Call the engine.
4. **Dates are dates.** Due dates are calendar dates (`date`, no time zone). Timestamps are UTC `timestamptz`. Display in the client's time zone (default Asia/Kolkata). Never compare a date to a timestamp without the engine helpers.
5. **No silent data changes on import.** Cleaning is proposed, shown, then applied. Keep the raw source value next to the cleaned one.
6. **Evidence is personal data.** Never log file contents, names of employees from evidence, or signed URLs. Signed URLs expire in 5 minutes.
7. **Validate at the edge.** All API input goes through a Zod schema shared with the client. No `any`.

## Working style for Claude in this repo
- Small PRs, one concern each. Migrations in their own PR when they change existing tables.
- Write or update tests in the same PR. Engine changes need unit tests with explicit dates; workflow changes need API tests for each role.
- The sample register is the golden fixture: `packages/importer/fixtures/sample-register.xlsx`. Its expected counts are in `docs/requirements/excel-analysis.md` §5. Do not edit the fixture; add new fixtures instead.
- When a requirement is unclear, check the Excel analysis, then `PLAN.md` §7 defaults, then ask. Record decisions as ADRs in `docs/adr/NNNN-title.md`.
- Do not add a dependency without saying why in the PR. Prefer what is already in the stack.
- Do not build "Later" items from `PLAN.md` §1 unless asked.

## Definition of done
Lint, typecheck, unit and e2e tests green; new UI checked in light mode at 1280px and 375px and keyboard-only;
audit events written for state changes; isolation test for new tables; docs or CLAUDE.md updated if a rule changed.

## Quality gates (CI, all feed the required `ci-ok` check)
| Gate | Job | What fails it |
|---|---|---|
| Lint, format, typecheck | `lint`, `typecheck` | ESLint, Prettier or `tsc` errors |
| Unit tests + coverage | `test` | a failing test, or coverage under 80% (engine: 95%, and 100% on files named `*status*` / `*score*`). Thresholds live in each package's `vitest.config.mjs` via `@canopy/vitest-config`; never lower one to get green |
| Database tests | `db` | a package's `test:db` script against Postgres 16 (`DATABASE_URL` is set). M3 puts tenant-isolation and migration tests here |
| End to end + accessibility | `e2e` | a Playwright journey, or an axe WCAG 2.2 AA violation (`e2e/support/a11y.ts`; call it on every page a journey visits) |
| Module paths | `module-paths` | a PR titled `M<n>: ...` changing files outside that module's paths in `tooling/modules.json` |
| Dependencies | `audit` | a known high or critical vulnerability (`pnpm audit`) |
| Static security | `codeql` | a CodeQL security-extended finding |
| Audit | `module-audit` | on every ready (non-draft) PR, no **Ready** verdict for the current head SHA: an audit session that did not build the PR runs `.claude/skills/compliance-module-auditor` (module PRs against their `MODULES.md` acceptance list, other PRs against these rules) and posts its report with a `<!-- canopy-audit sha=... verdict=Ready -->` marker. Only markers from people with write access count; a push makes earlier verdicts stale. CI reads the comments and calls no model API |

Gates owned by modules, added with their first code: contract tests against the OpenAPI spec (M0, consumed by M6, M7, M8, M10),
golden counts from `docs/requirements/excel-analysis.md` §5 (M4, M8), and a test that every state-changing route writes an `AuditEvent` (M7).

Title every module PR `M<n>: <what>` so the path guard and audit apply. Mark it ready for review only when you expect it to pass,
then get it audited in a separate session (the builder never audits its own work), and again after every push. Read the
audit comment and fix its findings.

Merging is automatic (`.github/workflows/auto-merge.yml`): every ready PR gets GitHub auto-merge and joins the merge
queue on `main` once `ci-ok` is green. Auto-merge is turned on with the `AUTOMERGE_TOKEN` secret, never `GITHUB_TOKEN`:
a PR queued as `GITHUB_TOKEN` gets no merge-queue CI run and blocks the queue. Until that secret exists, the thread that
owns a PR turns auto-merge on itself (`PUT /repos/CetizionVerifica/CMS/pulls/<n>/ccr/auto_merge` with
`merge_method=squash`) once the PR is ready. The queue re-runs CI on the PR combined with `main` and the PRs ahead of it, then
squash-merges, so two PRs that pass alone but break together never both land. Changes to contracts, `packages/db`,
auth, `.github`, `tooling/modules.json` or `.claude/skills` request Shyam's review (`.github/CODEOWNERS`), but merging
needs no approval, so the audit is their gate too. A PR runs its own copy of `ci.yml` and `.github/scripts`, so the
audit of a PR that touches them must check it doesn't weaken the gate. Open PRs as drafts while work is in progress; add the `no-automerge` label to
hold one. Do not merge by hand around a red check.

After a merge, `cleanup.yml` deletes the PR's branch, and GitHub moves any PR stacked on it to `main`; push follow-up work
from a fresh branch off `main`. Dependabot (`.github/dependabot.yml`) opens grouped dependency PRs weekly; they merge
themselves on green like any other PR.
