# Change requests from M2 to plan files

M2 owns only `packages/ui/spec/`. These changes touch `packages/ui/CLAUDE.md` (owned by the plan thread "Canopy build plan and CLAUDE.md"). Sent via the coordinator on 2026-10-11.

## CR-1 · Add contrast-safe status and control tokens (needed, not optional)

The brief's own rule is "text 4.5:1 minimum", but its status colours fail it as text:

- `--ok` on its pill background 3.79:1, `--warn` 3.17:1, `--crit` 4.24:1.
- `--line` as an input border is 1.26:1; WCAG 1.4.11 needs 3:1 for control boundaries.
- The mockup's sidebar group label (#9CC2AA on forest) is 3.29:1.

Proposed additions to the token table: `--ok-ink` #176B42, `--warn-ink` #8C5C04, `--crit-ink` #A8391F, `--ok-soft` #E3F3EA, `--warn-soft` #FBF0D9, `--crit-soft` #FBE5DF, `--neutral-soft` #EEF1EF, `--line-strong` #7A8A81, `--forest-hover` #185A3B, `--on-forest` #FFFFFF, `--on-forest-muted` #CFE3D6, `--on-forest-hover`, `--on-forest-selected`, `--scrim`. Rule to add: "`--ok`, `--warn`, `--crit` are for dots, icons and fills; text in a status tone uses the `-ink` token." Full audit: `spec/foundations.md` §1.4.

## CR-2 · Spacing and radius additions

Add `space-6` 32px and `space-7` 48px (page gaps, empty states) and `radius-tag` 6px (CriticalityTag, so criticality never looks like a status pill).

## CR-3 · Add primitives to the component build order

Button, IconButton, Input/Select/Combobox, Checkbox, Tabs, DropdownMenu/Popover/Tooltip, Avatar, Badge, Skeleton, Link go first; every listed component depends on them. Spec: `spec/components/00-primitives.md`.

## CR-4 · Minimum text size

Brief says 14px minimum body text; the mockup uses 10.5-11px labels. Proposed rule: "12px is the floor for any text (meta, labels, pills); 14px for content."

## CR-5 · TaskList marker is not a checkbox

The mockup's square checkbox implies one-click completion, which the workflow doesn't allow (evidence + approval). Spec uses a state marker circle instead. Overview card title "My open items" instead of "My tasks" (vocabulary rule).

## CR-6 · Help card text on forest

Spec 01 said the help card uses 12px text without a colour. `--on-forest-muted` on the card background (`--on-forest-hover`) measures 4.0:1 and fails the 4.5:1 rule, so the card uses `--on-forest`. `src/contrast.test.ts` records the measurement. Spec 01 Tokens updated.

## CR-7 · Period picker row under 640px

At 375px the top bar cannot fit the menu button, ClientSwitcher, PeriodPicker, search, primary action and avatar at 44px touch targets; axe's target-size check failed. Under 640px the PeriodPicker moves to a row below the top bar. Spec 01 Responsive updated.

## CR-8 · Structured primary action

Spec 01 had `primaryAction?: ReactNode`. The shell must collapse the action to an IconButton with a tooltip under 1100px, which it cannot do with arbitrary content, so it takes `{ label, icon, onClick | href }`. Spec 01 Props updated, along with the props the shell added (`brand`, `title`, `layout`, `renderLink`, `helpCard.linkLabel`).

## CR-9 · Axe scope while a modal popup is open

While a Radix Select, menu or dialog is open, Radix sets `aria-hidden` on the rest of the page and traps focus in the popup, so a whole-page axe run always flags `aria-hidden-focus` on content the user cannot reach. The gallery's Playwright checks scope axe to the popup while one is open (`e2e/a11y.ts` `openPopup`) and check the whole page when it is closed.

## CR-10 · Nav matching by prefix

`activeHref` now matches the nav item with the longest href that prefixes the current page at a path boundary, not only an exact match, so record pages keep their list's item current. Spec 01 Props updated.

## CR-11 · PeriodPicker takes the current period, not today

Spec 03 had `today` and `availableFys`-based disabling, and said FY boundaries come from an engine helper through contracts. `packages/ui` depends on nothing in the repo, so it cannot import that helper, and computing the current period from `today` would be compliance date logic outside the engine. The picker takes `thisPeriod` (the API resolves it with the engine in the client's time zone) and `availableUntil` (last month with generated instances). It still orders the twelve months from `fyStartMonth` for layout. Spec 03 updated.

## CR-12 · Timeline system actor name

Spec 16 named the system actor "Canopy". Client-facing text must not say "Canopy", so the actor is `systemName`, defaulting to "PlanetPulse Compliance". Spec 16 updated.

## CR-13 · ConfirmDialog name mode and returnFocusTo

Saved views need a one-line name field, so `reason` gains `multiline: false` (Enter confirms), `maxLength` and `initialValue`. `returnFocusTo` is now a prop, as spec 18's text already required. Spec 18 Props updated.

## CR-14 · DeadlineList Overdue group

Spec 12's week groups had no place for items due before today, which landed under "This week". Grouping now starts with "Overdue". Spec 12 updated.

## CR-15 · Toast queue

Spec 17 said older toasts collapse but not whether they return. A toast pushed out of the newest three is now gone for good (it never reappears later with a fresh timer); errors wait for a slot, up to 10 queued. Spec 17 updated.
