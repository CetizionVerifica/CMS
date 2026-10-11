# FilterBar

Row of filter chips and a search field above a DataTable. State lives in the URL (the web app maps it); the component is controlled.

## Anatomy
`[Search "Search title, ID or Act"]` · chips: **Status** · **Criticality** · **Department** · **Act** · **Owner** · **Approver** · **Unit** · **Due date** · `+ More` (less common fields) · spacer · "Clear all" (ghost, only when any filter is active).

Chip (Button `sm`, radius 999px, 32px):
- Empty: "Status" + `ChevronDown`, border 1px `--line-strong`, bg `--surface`.
- Active: "Status: Overdue, Due soon" (max 2 values, then "Status: Overdue +2"), bg `--sage`, text `--forest` 700, trailing `X` IconButton "Remove status filter".

Chip popover (Radix Popover, 280px): search within values (when > 8 values) · checkbox list with counts on the right (`type-meta` `--muted`, counts from API facets) · footer "Clear" and "Done". Values apply as they are ticked (no Apply step); the table shows the refetch bar.

Due date popover: presets (Overdue, This week, Next 30 days, This quarter, Custom range) + two date inputs.

## Props
```ts
type FilterDef = { key: string; label: string; kind: 'multi'|'dateRange'|'search'; options?: { value: string; label: string; count?: number }[]; order?: 'given'|'alpha' };
type FilterBarProps = {
  filters: FilterDef[];
  value: Record<string, string[] | { from?: string; to?: string }>;
  onChange: (v: FilterBarProps['value']) => void;
  search?: { value: string; onChange: (q: string) => void; placeholder?: string };
  primaryKeys?: string[];              // shown as chips; the rest go under "+ More"
};
```
Status and Criticality options follow enum order and use the same labels as StatusPill and CriticalityTag; each option shows the pill or tag next to its checkbox.

## States
Rest, hover (border `--forest`), focus ring, open, active, disabled (while the table is in error). Search debounces 250ms and shows a `X` clear button when not empty.

## Keyboard
Tab moves across search and chips. Enter/Space/ArrowDown opens a chip. Inside: type to search, ArrowUp/Down through options, Space toggles, Esc or Done closes and focus returns to the chip. Backspace on a focused active chip removes that filter.

## Accessibility
Wrapper `role="group"` `aria-label="Filters"`. Active chip name: "Status filter: Overdue, Due soon. Change". A polite live region reports the result count after changes ("38 instances match").

## Responsive
Under 1100px chips wrap to 2 lines max, then overflow into "+ More". Under 640px the bar becomes search + a "Filters (3)" button that opens a bottom sheet listing every filter as an accordion, with "Show 38 results" sticky at the bottom.
