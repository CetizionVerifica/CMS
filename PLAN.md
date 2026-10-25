# Canopy: root development plan

Canopy is a multi-client compliance management web app for a consultancy. Consultants manage many client
organisations; client staff (owners and approvers at each plant or office) complete and sign off statutory
obligations with evidence. The look follows the **Canopy** direction chosen in the design thread: calm light UI,
forest-green sidebar, client switcher at the top, medium density.

Requirements come from the client register export (`ASPxGridView1 (15) (1).xlsx`), analysed in
[docs/requirements/excel-analysis.md](docs/requirements/excel-analysis.md). That sheet is a **statutory legal
compliance** register (Indian labour, EHS, tax and IT laws for one plant), not an ESG dataset. So v1 is a statutory
compliance tool; the ESG framework screens from the design mockup (BRSR, CSRD, CBAM, GRI) are a later module that
reuses the same obligation/instance engine.

## 1. Product scope

### v1 (this plan)
- Multi-tenant: consultancy firm → clients → companies → units, with Country/State/City locations.
- Obligation library: Acts, obligations, categories, criticality, forms and log-sheet templates.
- Applicability and assignment of obligations to units, departments, owners and approvers.
- Recurring compliance instances generated from rules on the Indian financial year.
- Maker-checker workflow with evidence, comments, Not Applicable justification, and a full audit trail.
- Excel import of existing registers (the sample sheet is the acceptance fixture), and Excel/PDF export.
- Dashboards: consultant portfolio across clients, client overview, compliance calendar, approvals inbox.
- Email reminders and escalations.

### Add-ons (operator switches them on per account)
- **ISO management systems** (ISO 9001, 14001, 45001): clause checklists, documents, risk registers, objectives,
  internal audits, management reviews, nonconformities and corrective actions, certification. Plan:
  [docs/iso/plan.md](docs/iso/plan.md), ADR M16-0001. Modules M16 (API) and M17 (web) in `MODULES.md`.

### Later (not v1)
ESG/BRSR module, regulatory-change feed, penalty tracking, mobile app, SSO/SAML, client self-serve billing,
AI-assisted applicability. Keep the data model open for these but do not build them.

## 2. Users and roles

| Role | Who | Can do |
|---|---|---|
| Firm admin | Consultancy owner | Everything, all clients, billing, library |
| Consultant | Consultancy staff | Manage assigned clients, library edits, import, reports |
| Client admin | Client compliance head | Manage own org's units, people, assignments |
| Approver | Client manager | Approve, reject, mark NA (with reason) |
| Owner | Client staff | Submit instances with evidence and comments |
| Viewer / auditor | Internal audit, external auditor | Read-only, time-boxed access, export |

## 3. Architecture (defaults, change before Phase 0 ends if needed)

- **Monorepo**: pnpm workspaces + Turborepo, TypeScript everywhere, Node 22 LTS.
- **apps/web**: Next.js (App Router), React Server Components for reads, TanStack Table for the register, Tailwind with Canopy tokens from `packages/ui`.
- **apps/api**: Fastify + Zod, REST with an OpenAPI spec generated from Zod schemas; typed client consumed by web.
- **packages/db**: PostgreSQL 16, Drizzle ORM and migrations, Postgres row-level security for tenant isolation.
- **packages/engine**: pure TypeScript compliance logic (recurrence, due dates, status derivation, scores). No I/O.
- **packages/importer**: Excel parsing (SheetJS), column mapping, cleaning, dry-run and commit.
- **packages/ui**: Canopy design tokens and components (Radix primitives).
- **Jobs**: pg-boss on Postgres for instance generation, reminders, exports. No Redis in v1.
- **Files**: S3-compatible object storage for evidence; virus scan before available.
- **Auth**: email + password and magic link with session cookies; MFA for firm roles. SSO later.
- **Hosting**: one region (India, for data residency of client data), containers, managed Postgres.

```
canopy/
  CLAUDE.md                     root rules (read first)
  PLAN.md                       this file
  MODULES.md                    parallel module briefs (M0-M14)
  packages/contracts/           shared types, schemas, OpenAPI (M0)
  docs/requirements/            Excel analysis, decisions (ADRs)
  apps/web/CLAUDE.md            frontend rules
  apps/api/CLAUDE.md            backend, auth, roles, workflow rules
  packages/db/CLAUDE.md         schema, tenancy, migrations
  packages/engine/CLAUDE.md     recurrence, status, score calculations
  packages/importer/CLAUDE.md   Excel import and cleaning
  packages/ui/CLAUDE.md         Canopy design system
```

## 4. Core data model (summary; full rules in packages/db/CLAUDE.md)

`Firm` → `Client` (org group) → `Company` → `Unit` (+ `Location`).
`Act` → `Obligation` (title, description, category, criticality, timeline type, recurrence rule, forms, log sheets).
`Assignment` = Obligation × Unit × Department with default owner and approver, applicability status and reason.
`ComplianceInstance` = one dated occurrence of an Assignment: period, due date, status, completed on, owner, approver.
`Evidence`, `Comment`, `AuditEvent` hang off instances. `Person` and `Membership` tie users to firm/client roles.

## 5. Screens (Canopy shell)

Sidebar (forest green): **Overview, Compliance register, Calendar, Approvals, Evidence vault, Library, Reports, Audit trail**,
then a "Setup" group: **Entities & locations, People & roles, Import**. Top bar: client switcher, FY/period picker, search, "+ New", avatar.

1. **Portfolio** (consultant home): every client with score, overdue, due this week, last activity.
2. **Client overview**: KPI cards (compliance score ring, open, overdue, awaiting approval), readiness by department and by Act, upcoming deadlines, my tasks.
3. **Compliance register**: the Excel grid, done properly. Columns match the sheet; filters, saved views, grouping, bulk assign/approve, export.
4. **Instance drawer**: description, applicability, Act, forms and log sheets, evidence upload, comments, approve/send back/NA, audit history.
5. **Calendar**: month and list views of due dates, coloured by status.
6. **Approvals inbox**: submitted items for the approver, keyboard approve/send back.
7. **Library**: Acts and obligations, recurrence rules, templates; push changes to clients.
8. **Import**: upload, map columns, review cleaning suggestions, dry run, commit.
9. **Reports**: compliance certificate per unit and period, Act-wise and department-wise status, overdue list; Excel and PDF.
10. **Setup**: entity tree, people, roles, departments, reminder settings.

## 6. Build order: parallel modules

The build is split into 15 independent modules (M0-M14) that run as parallel threads in 5 waves, joined only by
shared contracts. Briefs, ownership, dependencies and acceptance criteria per module: [MODULES.md](MODULES.md).
No code is written until a wave is started.

## 7. Decisions taken by default (confirm or change)

1. Statutory compliance first, ESG later, because the requirements sheet is statutory.
2. Stack as in §3.
3. Indian financial year (Apr-Mar) default, configurable per client.
4. Score = criticality-weighted on-time completion (weights Super Critical 5, Critical 4, High 3, Medium 2, Low 1).
5. Reminders at T-7, T-3 and due day to the owner; escalation to the approver at +1 and +7 days overdue.
6. Not Applicable always needs a reason and approver sign-off.
7. Product name in UI is a placeholder ("Compliance Hub" in the mockup) until branding is chosen.

## 8. Risks

- **Library quality** is the product: wrong due-date rules mean wrong alerts. Mitigation: rule tests per obligation, consultant review step on library changes.
- **Dirty imports**: every client register will be messier than the sample. Mitigation: alias tables and a review step, never silent merges.
- **Evidence volume and privacy**: challans and HR records contain personal data. Mitigation: encryption at rest, per-tenant buckets or prefixes, access logged.
- **Scope pull toward ESG** before statutory core is solid. Mitigation: ESG stays in "Later" until Phase 6 exits.
