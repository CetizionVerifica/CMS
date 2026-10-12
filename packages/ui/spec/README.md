# Canopy component spec (M2)

Specification for the Canopy design system, written before code (Shyam: plan first, no app code yet). When the repo exists, M2 builds `packages/ui` from this folder; M11-M13 compose screens from it.

Visual gallery: https://claude.ai/artifact/J724MvTHhciETD9eA7NK23

## Read in this order

1. [`foundations.md`](foundations.md): colour tokens with a computed contrast audit, type scale, spacing, radius, elevation, motion, focus, icons, breakpoints, copy and formatting, testing contract.
2. [`tokens.json`](tokens.json): the same tokens in W3C Design Tokens format, to generate `tokens.css` and `tailwind.preset.ts`.
3. [`status-language.md`](status-language.md): status, criticality and workflow verbs.
4. `components/`: one file per component, in build order.
5. [`change-requests.md`](change-requests.md): edits this spec needs in `packages/ui/CLAUDE.md`.

## Components

| #   | Component                                                                                                | Radix base                      | Depends on     |
| --- | -------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------- |
| 00  | [Primitives](components/00-primitives.md) (Button, Input, Tabs, Menu, Tooltip, Avatar, Badge, Skeleton…) | various                         | tokens         |
| 01  | [AppShell](components/01-app-shell.md)                                                                   | Dialog (mobile sheet), Tooltip  | 00             |
| 02  | [ClientSwitcher](components/02-client-switcher.md)                                                       | Popover                         | 00             |
| 03  | [PeriodPicker](components/03-period-picker.md)                                                           | Popover, Select, ToggleGroup    | 00             |
| 04  | [KpiCard](components/04-kpi-card.md)                                                                     | none                            | 05             |
| 05  | [ScoreRing](components/05-score-ring.md)                                                                 | none                            | tokens         |
| 06  | [ProgressBar](components/06-progress-bar.md)                                                             | none                            | tokens         |
| 07  | [StatusPill](components/07-status-pill.md)                                                               | none                            | tokens         |
| 08  | [CriticalityTag](components/08-criticality-tag.md)                                                       | none                            | tokens         |
| 09  | [DataTable](components/09-data-table.md)                                                                 | Popover, DropdownMenu, Checkbox | 00, 07, 08, 14 |
| 10  | [FilterBar](components/10-filter-bar.md)                                                                 | Popover, Checkbox               | 00, 07, 08     |
| 11  | [Drawer](components/11-drawer.md)                                                                        | Dialog                          | 00, 14, 18     |
| 12  | [DeadlineList](components/12-deadline-list.md)                                                           | none                            | 07             |
| 13  | [TaskList](components/13-task-list.md)                                                                   | none                            | 00, 17, 18     |
| 14  | [EmptyState](components/14-empty-state.md)                                                               | none                            | 00             |
| 15  | [FileDrop](components/15-file-drop.md)                                                                   | none                            | 00, 06, 18     |
| 16  | [Timeline](components/16-timeline.md)                                                                    | none                            | tokens         |
| 17  | [Toast](components/17-toast.md)                                                                          | Toast                           | 00             |
| 18  | [ConfirmDialog](components/18-confirm-dialog.md)                                                         | AlertDialog                     | 00             |

Every component spec has: anatomy, props (TypeScript sketch), states, keyboard, accessibility and content rules. Every component meets the testing contract in `foundations.md` §10.

## Acceptance demo: Canopy overview from components only

M2's acceptance (MODULES.md) is an overview page composed purely from these components that matches the mockup. Mapping, adapted from the ESG mockup to v1 statutory scope:

| Mockup region             | Component                                                          | v1 content                                                                                                                |
| ------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Green sidebar             | AppShell                                                           | Overview, Register, Calendar, Approvals (4), Evidence · Reporting: Reports, Audit trail · Setup: Entities, People, Import |
| Client chip               | ClientSwitcher                                                     | "Kestrel Aluminium Riverbend · Metals · 1 unit"                                                                               |
| FY chip                   | PeriodPicker                                                       | "FY 2022–23"                                                                                                              |
| "+ Request data"          | Button primary                                                     | "Assign obligation"                                                                                                       |
| Greeting + sub line       | page `h1` + `type-body` `--muted`                                  | "5 items are overdue, 2 are super critical."                                                                              |
| KPI row                   | KpiCard ×4 (first with ScoreRing)                                  | Compliance score · Open · Overdue · Awaiting approval                                                                     |
| Framework readiness table | DataTable (no toolbar) + ProgressBar + StatusPill                  | Readiness by department                                                                                                   |
| Upcoming                  | DeadlineList                                                       | next 5 due dates                                                                                                          |
| Emissions chart           | ProgressBar `stacked` per Act (chart component is out of M2 scope) | Status by Act, top 6                                                                                                      |
| My tasks                  | TaskList                                                           | "My open items"                                                                                                           |

Sample data for the demo: the golden fixture counts (424 instances, 211 complied / 201 pending / 12 not applicable).

## Decisions taken in this spec (defaults, change if Shyam disagrees)

- Status text uses new `-ink` tokens; base status colours stay for fills (CR-1).
- 12px text floor; 14px content (CR-4).
- `en-IN` number grouping by default.
- Super critical is the only filled criticality tag; criticality tags are square, status pills round.
- Drawer opens focus on the title, not the close button.
- Evidence limits default to PDF/JPG/PNG/XLSX/DOCX, 25 MB, to confirm with M7.
- No charts component in M2 v1; the overview uses stacked progress bars. A chart wrapper can be added when M10/M13 need one.
