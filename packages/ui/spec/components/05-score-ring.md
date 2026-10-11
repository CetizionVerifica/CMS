# ScoreRing

Circular gauge for a 0-100 score (compliance score, completion of a period).

## Anatomy

SVG: track circle `--sage`, fill arc from 12 o'clock clockwise in `--forest`, round caps. Optional centre text (value) for `lg`.

| Size | Diameter | Stroke | Centre text                            |
| ---- | -------- | ------ | -------------------------------------- |
| `sm` | 40       | 5      | none                                   |
| `md` | 58       | 7      | none (value sits beside it in KpiCard) |
| `lg` | 96       | 10     | value `type-kpi` + "%" `type-meta`     |

## Props

```ts
type ScoreRingProps = {
  value: number | null;
  size?: 'sm' | 'md' | 'lg';
  label: string;
  tone?: 'brand' | 'status';
  band?: 'ok' | 'warn' | 'crit';
};
```

- `tone="brand"` (default): fill `--forest` regardless of value. The number and the KpiCard context carry meaning.
- `tone="status"`: fill `--ok`, `--warn` or `--crit` from the `band` prop. The API supplies the band with the score (suggested default bands: ≥90, 70-89, <70); the component never computes it.
- `value=null`: dashed track, no fill, centre "—"; label "No score yet".

## Accessibility

`role="img"` with `aria-label` "{label}: 78%" (or "No score yet"). Values clamp to 0-100 visually; out-of-range values log a dev warning.

## Motion

Arc animates from 0 to value once on mount (300ms `--ease-out`); none under reduced motion.
