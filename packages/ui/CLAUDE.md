# packages/ui: Canopy design system

Rules for tokens and shared components. Root `CLAUDE.md` applies. Reference mockup: "ESG Compliance UI Directions", option A (Canopy).

## Principles
1. **Status before detail.** Every screen opens on what is overdue or needs a decision, then lets users drill in.
2. **Calm, not loud.** Light neutral surfaces, one green accent. Colour carries status, not decoration.
3. **Readable by plant staff.** Plain language, 14px for content and 12px as the floor for any text (meta, labels, pills), generous click targets (36px min, 44px on touch).
4. **One family of type.** Plus Jakarta Sans for everything; hierarchy from weight (500-800) and size.

## Tokens (source of truth: `src/tokens.css`, mirrored in `tailwind.preset.ts`)
| Token | Value | Use |
|---|---|---|
| `--forest` | #1F6B47 | Sidebar, primary buttons, focus ring, selected state |
| `--leaf` | #2F8F60 | Progress fills, secondary emphasis |
| `--moss` | #A9C97A | Logo mark, tertiary chart series |
| `--sage` | #D9E8DC | Soft accent backgrounds, progress track, FY chip |
| `--mist` | #F5F7F4 | App background |
| `--surface` | #FFFFFF | Cards, tables, drawers |
| `--ink` | #13221A | Primary text |
| `--muted` | #5F6F66 | Secondary text, table headers |
| `--line` | #E1E7E2 | Borders, dividers |
| `--ok` | #1E8A55 | Complied |
| `--warn` | #B97A06 | Due soon, awaiting review |
| `--crit` | #C0442A | Overdue, rejected, Super Critical |
| `--ok-ink` / `--warn-ink` / `--crit-ink` | #176B42 / #8C5C04 / #A8391F | Text in a status tone (4.5:1 on the soft backgrounds) |
| `--ok-soft` / `--warn-soft` / `--crit-soft` / `--neutral-soft` | #E3F3EA / #FBF0D9 / #FBE5DF / #EEF1EF | Pill and banner backgrounds |
| `--line-strong` | #7A8A81 | Input and control borders (3:1 for WCAG 1.4.11) |
| `--forest-hover` | #185A3B | Hover on forest buttons |
| `--on-forest` / `--on-forest-muted` | #FFFFFF / #CFE3D6 | Text on the sidebar; plus `--on-forest-hover`, `--on-forest-selected` |
| `--scrim` | see spec | Overlay behind drawers and dialogs |

`--ok`, `--warn` and `--crit` are for dots, icons and fills only. Text in a status tone uses the `-ink` token. Full contrast audit: `spec/foundations.md` §1.4.

Radius: cards 12px, inputs/buttons 9-10px, pills 999px, `radius-tag` 6px (CriticalityTag, so criticality never looks like a status pill). Spacing scale 4px base (4, 8, 12, 14, 16, 22, plus `space-6` 32px and `space-7` 48px for page gaps and empty states). Shadows: none on cards; a soft shadow only on overlays (drawer, menu, dialog).
Numbers use `font-variant-numeric: tabular-nums`. Dark mode is out of scope for v1 but every colour must be a token so it can be added.

## Status language (fixed; use the `StatusPill` component, never ad-hoc colours)
| Status | Label | Tone |
|---|---|---|
| UPCOMING | Upcoming | neutral |
| DUE_SOON | Due in N days | warn |
| OVERDUE | Overdue N days | crit |
| SUBMITTED | Awaiting approval | warn |
| SENT_BACK | Sent back | crit |
| COMPLIED | Complied | ok |
| COMPLIED_LATE | Complied late | ok with warn dot |
| NOT_APPLICABLE | Not applicable | neutral |

Criticality uses `CriticalityTag` (6px radius, not a pill): Super Critical and Critical are crit-toned, High warn, Medium and Low neutral. Always show the text, never colour alone.

## Components (build in this order)
Primitives first, since everything else depends on them: Button, IconButton, Input/Select/Combobox, Checkbox, Tabs, DropdownMenu/Popover/Tooltip, Avatar, Badge, Skeleton, Link (spec: `spec/components/00-primitives.md`). Then:
AppShell (sidebar + top bar), ClientSwitcher, PeriodPicker (FY / quarter / month), KpiCard, ScoreRing, ProgressBar, StatusPill,
CriticalityTag, DataTable (wraps TanStack Table: sticky header, column chooser, saved views), FilterBar, Drawer, DeadlineList,
TaskList (state-marker circle, never a checkbox: completing needs evidence and approval), EmptyState, FileDrop, Timeline (audit), Toast, ConfirmDialog.

## Rules
- Build on Radix primitives for anything interactive (menu, dialog, popover, select, tabs). No hand-rolled focus traps.
- Every component has a story or a demo page and a test for keyboard use.
- Contrast: text 4.5:1 minimum, control boundaries 3:1; check `--muted` on `--mist`, `-ink` on `-soft`, and `--on-forest-muted` on `--forest` when tokens change.
- Detailed component specs and the gallery live in `spec/` (owned by M2); this file sets the rules, the spec sets the anatomy.
- Setup, the token-to-Tailwind mapping and the test commands are in `README.md`. A new component needs a demo page listed in `demo/routes.ts`; Playwright then checks it with axe at 1280px and 375px.
- Visible focus ring: 2px `--forest` with 2px offset on every focusable element.
- Icons: one icon set (Lucide), 16px in tables, 18px in nav. Icons never stand alone without a label or `aria-label`.
- Charts: use the Canopy series order forest, leaf, moss; status charts use ok/warn/crit tokens. Every chart has a text summary or table alternative.
- Responsive: sidebar collapses to an icon rail under 1100px and to a bottom sheet menu under 640px. Tables scroll horizontally inside their card, never the page.
- Copy: sentence case, verbs on buttons ("Submit for approval", "Send back"), dates as "31 Mar 2027".
