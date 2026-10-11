# ProgressBar

Linear completion for a row (a department, an Act) or a stacked status breakdown.

## Variants
| Variant | Look | Use |
|---|---|---|
| `single` (default) | track `--sage`, fill `--leaf`, height 7px, radius 999px | "Readiness by department" rows: 82% |
| `tone` | same, fill `--ok` / `--warn` / `--crit` from a `band` prop | When the API marks a row at risk |
| `stacked` | segments ok · warn · crit · neutral in that order, 2px white gap between segments, height 10px | Complied / pending / overdue / NA split for one department |

## Anatomy
`[label]` optional above or left · bar (fixed width 120px in tables, fluid elsewhere) · value text right (`type-body` tabular, "82%" or "171 of 208").
Stacked variant adds a legend underneath or in a tooltip: square 9px swatch + label + count.

## Props
```ts
type ProgressBarProps =
  | { variant?: 'single'|'tone'; value: number; max?: number; band?: 'ok'|'warn'|'crit'; label: string; showValue?: boolean }
  | { variant: 'stacked'; segments: { key: 'ok'|'warn'|'crit'|'neutral'; label: string; count: number }[]; label: string; legend?: 'below'|'tooltip'|'none' };
```

## Accessibility
`single`/`tone`: `role="progressbar"` with `aria-valuenow`, `aria-valuemin=0`, `aria-valuemax`, `aria-label`. `stacked`: `role="img"` with a full sentence label ("Human Resources: 120 complied, 30 due soon, 8 overdue, 2 not applicable"); the legend is real text. Segments under 2% still render at 3px minimum so they are visible, and the label keeps the exact count.

## States
Loading: track only with pulse. Zero: track only, value "0%". Value > max clamps visually.
