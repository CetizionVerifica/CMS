# KpiCard

One headline number with a label and a one-line context, linking to the register filtered to exactly those rows.

## Anatomy

Card (`--surface`, 1px `--line`, `radius-card`, padding 14px 16px):

1. Optional leading visual: ScoreRing (`md`) or none.
2. Label (`type-meta` `--muted`): "Compliance score", "Open", "Overdue", "Awaiting approval".
3. Value (`type-kpi`, tabular) with optional unit (`type-meta` 600 `--muted`, e.g. "of 424").
4. Context line (`type-meta` 600) in a tone: "▲ 6 pts this month" (ok-ink), "2 super critical" (crit-ink), "9 due this week" (warn-ink), or neutral `--muted`.

## Props

```ts
type KpiCardProps = {
  label: string;
  value: number | string; // numbers are locale-formatted by the component
  unit?: string;
  context?: { text: string; tone?: 'ok' | 'warn' | 'crit' | 'neutral'; trend?: 'up' | 'down' };
  visual?: ReactNode; // e.g. <ScoreRing value={78} size="md" />
  href?: string; // whole card becomes a link
  loading?: boolean;
  error?: string;
};
```

Numbers are formatted by the component (locale per foundations §9); their values come from the API.

## States

| State      | Treatment                                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| Rest       | as anatomy                                                                                                  |
| Link hover | border `--line-strong`, value unchanged, `ArrowUpRight` 16px appears top-right in `--muted`                 |
| Focus      | ring on the card (`radius-card`)                                                                            |
| Loading    | skeleton: label bar 60px, value bar 80×26, context bar 100px                                                |
| Error      | value "—", context "Couldn't load" in `--muted` with Retry ghost button (card is not a link while in error) |
| Zero       | show "0"; an overdue of 0 uses ok-ink context "Nothing overdue"                                             |

## Accessibility

When `href` is set the card is one `<a>` whose accessible name reads label, value and context in order ("Overdue, 5, 2 super critical. View in register"). Trend arrows are `aria-hidden`; the text carries direction ("up 6 points this month"). Never colour alone: tone always paired with words.

## Layout

KPI row grid: 4 / 2 / 1 columns (foundations §8), gap 12px, equal heights. Value never wraps; long values shrink to 22px before truncating.
