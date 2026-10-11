# apps/web: frontend

Next.js App Router, TypeScript, Tailwind with the Canopy preset from `packages/ui`. Root `CLAUDE.md` and `packages/ui/CLAUDE.md` apply.

## Routes
```
/login, /invite/[token]
/portfolio                                  consultant home: all clients
/c/[clientId]/overview                      client overview dashboard
/c/[clientId]/register                      compliance register grid (?view=, filters in the URL)
/c/[clientId]/register/[instanceId]         instance drawer over the register (deep-linkable)
/c/[clientId]/calendar
/c/[clientId]/approvals
/c/[clientId]/evidence
/c/[clientId]/reports
/c/[clientId]/audit
/c/[clientId]/setup/{entities,people,departments,reminders}
/c/[clientId]/import                        upload → map → review → dry run → commit
/library/{acts,obligations}                 firm-wide library
```
The client switcher changes `[clientId]` and keeps the rest of the path. The period picker writes `?fy=2022-23&q=Q3` and every page respects it.

## Data and state
- Server Components fetch through the typed API client; Client Components only for interaction (grid, drawer, forms, uploads).
- Mutations via Server Actions that call the API, then `revalidateTag` for the affected client. TanStack Query only inside the register grid for fast filter changes.
- **Filters, sort, grouping and selected period live in the URL** so views are shareable and the back button works.
- No compliance logic in the frontend: status labels, overdue days and scores come from the API (engine output). Formatting only.
- Forms: React Hook Form + the shared Zod schemas from the API package.

## Screen rules
- **Overview**: greeting line states the top issue in words ("5 items are overdue, 2 are Super Critical"). KPI cards: compliance score ring, open, overdue, awaiting approval. Then readiness by department and by Act, upcoming deadlines, "My open items". Every number links to the register filtered to exactly those rows.
- **Register**: default columns mirror the Excel (ID, Title, Act, Department, Owner, Approver, Due date, Status, Criticality); description, applicability, forms and log sheets are in the drawer. Virtualised rows; must stay smooth at 10,000 rows. Saved views per user; bulk assign, bulk approve, export current view.
- **Instance drawer**: header with status and due date, then description (keep line breaks and numbering), applicability, Act, forms, log-sheet templates, evidence, comments and audit timeline. The primary action depends on role and state (Submit, Approve, Send back, Request NA).
- **Approvals**: list with keyboard shortcuts (J/K move, A approve, S send back with reason).
- **Import**: four-step wizard, progress kept on the server (`import_batch`), resumable.

## Quality bar
- Every page has loading, empty, error and no-permission states.
- Keyboard-only path for submit and approve; axe checks in Playwright on every route.
- Dates displayed "31 Mar 2027", in the client's time zone; relative text ("in 3 days") next to, not instead of, the date.
- Playwright e2e for: login, switch client, filter register, submit with evidence, approve, send back, import the sample file.
- No new UI colours or spacing outside the tokens; add a token in `packages/ui` first.
