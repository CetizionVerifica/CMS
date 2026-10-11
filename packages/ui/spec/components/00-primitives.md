# Primitives

Not in the component list of `packages/ui/CLAUDE.md`, but every listed component is built from them, so they ship first. Interactive ones wrap Radix. Each follows the testing contract in `foundations.md` §10.

## Button

| Variant     | Rest                                                  | Hover / pressed     | Use                                                   |
| ----------- | ----------------------------------------------------- | ------------------- | ----------------------------------------------------- |
| `primary`   | bg `--forest`, text `--on-forest` 700                 | bg `--forest-hover` | One per view region: "Submit for approval", "Approve" |
| `secondary` | bg `--surface`, 1px `--line-strong`, text `--ink` 700 | bg `--mist`         | "Send back", "Export", "Cancel"                       |
| `ghost`     | transparent, text `--forest` 700                      | bg `--mist`         | Card links ("View all"), toolbar actions              |
| `danger`    | bg `--crit`, text white 700                           | bg `--crit-ink`     | Destructive confirm only (inside ConfirmDialog)       |

- Sizes: `md` 36px (default), `sm` 32px (tables, filter bar), touch 44px automatically under `pointer: coarse`. Padding 0 14px; icon 18px with 8px gap.
- States: rest, hover, `:focus-visible` (ring; on primary the ring sits outside in `--forest` with 2px offset so it shows against mist), pressed, disabled (opacity .5, `aria-disabled`, still focusable when it has a tooltip explaining why), loading (spinner replaces icon, label stays, `aria-busy="true"`, not clickable).
- Radius `radius-control`. Text sentence case, verb first.
- A disabled action that the user might expect says why: tooltip "Only the approver can approve".

## IconButton

Square 36px (44 touch), icon 18px, `ghost` style. `aria-label` is required by the type signature. Tooltip shows the same label on hover/focus after 400ms.

## Input, Textarea, Select, Combobox

- Height 36px, radius `radius-control`, border 1px `--line-strong`, bg `--surface`, text `type-body`, placeholder `--muted`.
- Label above (`type-meta` `--ink` 600), helper text below (`type-meta` `--muted`), error below (`type-meta` `--crit-ink`, `AlertCircle` 16px), error border `--crit`, `aria-invalid` and `aria-describedby` wired to helper and error.
- Focus: ring per foundations §6 (border stays).
- Select and Combobox: Radix Select / Popover + listbox; options 36px; selected option has `Check` icon and `aria-selected`.
- Date input: text field accepting "31 Mar 2027" or "31/03/2027", with a calendar popover (Radix Popover); value is a calendar date string `YYYY-MM-DD`, no time zone.

## Checkbox, Radio, Switch

Radix primitives. Box 16px drawn inside a 36px hit area, border 1.5px `--line-strong`, radius 4px; checked bg `--forest` with white `Check`; indeterminate shows a bar. Label is clickable.

## Tabs

Radix Tabs. Tab height 36px, text `--muted` 600; selected text `--ink` 700 with a 2px `--forest` underline. Arrow keys move, Home/End jump. Overflow scrolls horizontally with fade edges.

## DropdownMenu, Popover, Tooltip

Radix. Surface bg, 1px `--line`, `radius-card`, `--shadow-overlay`, z `z-popover`, padding 6px. Menu items 36px, radius 7px, hover/highlight bg `--mist`; destructive item text `--crit-ink`. Tooltip: bg `--ink`, text white `type-meta`, radius 6px, max width 280px, never holds information that is not also reachable by keyboard.

## Avatar

Circle, sizes 24 / 32 / 40. Initials (`type-meta` 700, `--forest`) on `--sage` (5.08:1). Image when available, `alt` = person name. A list of avatars shows max 3 then "+N".

## Badge (count)

Pill, min width 20px, height 20px, `type-meta` 700. On forest: bg `--on-forest-selected`, text white. On surface: bg `--neutral-soft`, text `--ink`. Counts above 99 show "99+". Accessible name includes the noun: "Approvals, 4 waiting".

## Skeleton

Blocks in `--neutral-soft` with a 1.2s opacity pulse (no shimmer under reduced motion). Container gets `aria-busy="true"`; one visually hidden "Loading overview" message per region, not per block.

## Link

`--forest`, 600, underline on hover and focus; underline always inside body copy. External links get `ExternalLink` 14px and `rel="noopener"`.
