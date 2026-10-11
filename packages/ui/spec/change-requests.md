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
