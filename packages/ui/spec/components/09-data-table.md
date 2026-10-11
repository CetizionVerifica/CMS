# DataTable

The register grid and every other list of records. Wraps TanStack Table (state) and TanStack Virtual (rows). Must stay smooth at 10,000 rows.

## Anatomy

Inside a card (`radius-card`, overflow hidden, horizontal scroll inside the card):

1. **Toolbar** (optional, 52px): saved-view menu ("View: Overdue super critical ▾") · result count ("424 instances", `type-meta` `--muted`) · spacer · density toggle · column chooser IconButton (`Columns3`) · Export button.
2. **Bulk bar** (replaces toolbar while ≥1 row selected): "12 selected" · Clear · bulk actions (Assign, Approve, Export) · right-aligned.
3. **Header row** (sticky, `z-sticky`, bg `--surface`, 1px `--line` bottom): select-all checkbox · column headers `type-label` `--muted`, sortable ones show `ArrowUpDown` 14px on hover, `ArrowUp`/`ArrowDown` when sorted. Resizable via a 6px handle.
4. **Rows**: 44px comfortable / 36px compact; 1px `--line` top border; hover bg `--mist`; selected bg `--neutral-soft` plus a 3px `--forest` inset bar on the left edge. Focused row: ring inside the row.
5. **First column** sticky on horizontal scroll (ID + title).
6. **Footer** (optional): totals for numeric columns.

## Column types

| Type          | Align | Cell                                                                                                  |
| ------------- | ----- | ----------------------------------------------------------------------------------------------------- |
| `id`          | left  | `type-meta` tabular, `--muted`, copy-on-click button with toast                                       |
| `title`       | left  | `type-body-strong`, max 2 lines, link to the instance drawer; second line `type-meta` `--muted` (Act) |
| `text`        | left  | 1 line, truncate with tooltip of full text                                                            |
| `date`        | left  | "31 Mar 2027", tabular; optional relative line                                                        |
| `number`      | right | tabular                                                                                               |
| `status`      | left  | StatusPill `sm`                                                                                       |
| `criticality` | left  | CriticalityTag `sm`                                                                                   |
| `person`      | left  | Avatar 24 + name; "Unassigned" in `--muted`                                                           |
| `progress`    | left  | ProgressBar 120px                                                                                     |
| `actions`     | right | IconButton `MoreHorizontal` → DropdownMenu                                                            |

Register default columns (from `apps/web/CLAUDE.md`): ID, Title, Act, Department, Owner, Approver, Due date, Status, Criticality.

## Props

```ts
type DataTableProps<T> = {
  columns: ColumnDef<T>[];             // TanStack, with meta.type from the table above
  data: T[];
  rowId: (row: T) => string;
  rowHref?: (row: T) => string;        // title cell link + row click
  sorting?: SortingState; onSortingChange?: …;     // controlled from URL
  selection?: { enabled: boolean; bulkActions: BulkAction[] };
  views?: { list: SavedView[]; current?: string; onSave; onRename; onDelete; onSetDefault };
  columnVisibility?: VisibilityState; columnOrder?: string[]; onColumnsChange?: …;
  density?: 'comfortable'|'compact';
  loading?: boolean; error?: { message: string; retry: () => void };
  empty?: ReactNode;                   // an EmptyState
  totalCount?: number;
};
```

## Column chooser

Radix Popover: search, list of checkboxes (title column locked on), drag handle to reorder (keyboard: select item, Alt+ArrowUp/Down), "Reset to default".

## Saved views

Radix DropdownMenu: "Default", personal views, divider, "Save current view…" (dialog with name), "Rename", "Delete" (ConfirmDialog), "Set as my default". A view stores filters, sort, columns, density. Unsaved changes to a view show "• Edited" next to its name with "Save" and "Discard".

## States

| State                      | Treatment                                                               |
| -------------------------- | ----------------------------------------------------------------------- |
| Loading first page         | header + 8 skeleton rows                                                |
| Refetching (filter change) | keep rows, 2px `--leaf` indeterminate bar under the header, `aria-busy` |
| Empty (no data at all)     | EmptyState "first-use" inside the card                                  |
| Empty (filters)            | EmptyState "no-results" with "Clear filters"                            |
| Error                      | EmptyState "error" with Retry                                           |
| No permission              | EmptyState "no-permission"                                              |

## Keyboard

Semantic `<table>` with `aria-rowcount` (total) and `aria-rowindex` on each rendered row, so virtualisation does not hide size from screen readers.

| Key                     | Result                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| Tab                     | Into the table: lands on the first row's title link; Tab again leaves the table (rows are not each a tab stop) |
| ArrowUp / ArrowDown     | Move between row title links (roving focus); virtual list scrolls to keep focus visible                        |
| Home / End              | First / last row (fetches if needed)                                                                           |
| Enter                   | Open drawer for focused row                                                                                    |
| Space                   | Toggle selection of focused row                                                                                |
| Shift+Space             | Range select from last anchor                                                                                  |
| Ctrl/Cmd+A (in table)   | Select all matching rows (asks "Select all 424 or just the 50 shown?" in the bulk bar)                         |
| Enter / Space on header | Cycle sort none → asc → desc                                                                                   |

## Accessibility

Header cells use `<th scope="col">` with `aria-sort`. Selection checkboxes labelled "Select TAX-CL-033…, Tax collection at source". Bulk bar changes are announced ("12 selected"). Sticky elements never cover focused rows (scroll-padding).

## Performance

Virtualised rows with 10 rows overscan; column widths fixed after first measure; no per-cell React state. Budget: 60 fps scroll and < 100 ms filter re-render at 10,000 rows on a mid laptop. M2 ships a 10k-row demo to prove it.

## Responsive

Under 640px the table stays a table (horizontal scroll in the card) with the sticky first column; density forced to comfortable for touch. A card-list alternative is out of scope for v1.
