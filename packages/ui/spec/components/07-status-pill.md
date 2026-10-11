# StatusPill

The only way to show an instance status. Vocabulary and colours: [`../status-language.md`](../status-language.md).

## Anatomy

Pill (radius 999px, height 22px, padding 3px 9px, gap 6px): dot 6px (or icon 14px in `md` with `withIcon`) · label `type-meta` 700.

## Props

```ts
type StatusPillProps = {
  status: DerivedStatus; // from contracts (M0)
  days?: number; // from API, used by DUE_SOON and OVERDUE labels
  size?: 'sm' | 'md'; // sm 20px for dense tables, md 22px default
  withIcon?: boolean; // icon replaces dot
  dueDate?: string; // YYYY-MM-DD; adds tooltip "Due 31 Mar 2027"
};
```

`days` missing for `DUE_SOON`/`OVERDUE` falls back to "Due soon" / "Overdue" and logs a dev warning.

## States

Static, not interactive: no hover or focus. If a pill must be clickable (e.g. filter by this status), wrap it in a Button `ghost` with its own accessible name; the pill itself stays presentational.

## Accessibility

Renders as `<span>` with the visible label as its text. The dot and icon are `aria-hidden`. `COMPLIED_LATE` warn dot has no separate meaning beyond the word "late". Truncated labels never happen: pills do not shrink below their content; table columns size to the longest label ("Awaiting approval", 132px at `sm`).

## Do / don't

- Do keep the label exactly as listed. Don't invent "Pending", "In progress", "Done".
- Don't put a StatusPill on a coloured background other than `--surface` or `--mist`.
- Don't use pill colours for anything except status.
