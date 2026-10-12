# PeriodPicker

Selects the reporting period every page respects. Writes `?fy=2022-23` plus optionally `&q=Q3` or `&m=2022-10`.

## Anatomy

Trigger: the sage **FY chip** (bg `--sage`, text `--forest` `type-body-strong`, radius `radius-chip`, padding 7px 11px, height 36px) reading "FY 2022–23", "FY 2022–23 · Q3" or "FY 2022–23 · Oct 2022", plus `ChevronDown` 16px.
Popover (300px):

1. FY select (Radix Select): list from client's first FY to next FY.
2. Granularity ToggleGroup: Year · Quarter · Month.
3. Grid: Q1-Q4 (each shows months, "Q3 Oct–Dec") or 12 month buttons in FY order (Apr … Mar for the default FY start).
4. Footer: "This period" shortcut (current quarter of current FY). Selection applies immediately and closes the popover; there is no Apply button.

## Props

```ts
type Period = { fy: string; quarter?: 1 | 2 | 3 | 4; month?: string /* YYYY-MM */ };
type PeriodPickerProps = {
  value: Period;
  onChange: (p: Period) => void; // web app maps to URL
  fyStartMonth?: number; // 1-12, default 4 (April); per client
  availableFys: string[]; // e.g. ["2022-23", "2023-24"]
  thisPeriod?: Period; // current quarter of the current FY, from the engine via the API; omit to hide "This period"
  availableUntil?: string; // YYYY-MM, last month with generated instances; later cells are disabled
};
```

The component has no `today`: the API resolves the current period in the client's time zone (engine) and passes `thisPeriod`. The picker only lays out the twelve months of an FY in order from `fyStartMonth` (`src/lib/period.ts`), which is display arithmetic, not a compliance rule; `packages/ui` cannot import contracts or the engine (CR-11).

## States

Rest / hover (1px `--forest` border) / focus ring / open. Current period button in grid: 1px `--forest` border. Selected: bg `--forest`, text white. Months after `availableUntil`: disabled with tooltip "No instances generated yet".

## Keyboard

Trigger opens with Enter/Space/ArrowDown and focuses the selected grid cell, every time it opens (not the cell focused last time). Arrow keys move across the grid (roving tabindex), Enter selects, Tab moves between FY select, toggle group and grid, Esc closes.

## Accessibility

Trigger name "Period: FY 2022–23, quarter 3, change period". Grid is a `radiogroup` labelled "Quarter" or "Month"; each option has the full name ("October 2022").
