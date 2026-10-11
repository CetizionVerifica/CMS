# CriticalityTag

Shows an obligation's criticality. Vocabulary: [`../status-language.md`](../status-language.md).

## Anatomy
Tag (radius `radius-tag` 6px, height 22px, padding 2px 8px, `type-meta`): optional icon 14px (Super critical only) · label.

| Level | Background | Border | Text |
|---|---|---|---|
| Super critical | `--crit-soft` | none | `--crit-ink` 700 + `OctagonAlert` |
| Critical | transparent | 1px `--crit` | `--crit-ink` 600 |
| High | transparent | 1px `--warn` | `--warn-ink` 600 |
| Medium | transparent | 1px `--line-strong` | `--muted` 600 |
| Low | `--neutral-soft` | none | `--muted` 600 |

## Props
```ts
type CriticalityTagProps = { level: Criticality; size?: 'sm'|'md' };
```

## Accessibility
Text always visible; the icon is `aria-hidden`. In a table the column header gives context, so the tag reads "Super critical", not "Criticality: Super critical". In free text (drawer header) prefix with a visually hidden "Criticality:".

## Sorting
Order for sort and filter lists: Super critical, Critical, High, Medium, Low (the enum order from contracts, never alphabetical).
