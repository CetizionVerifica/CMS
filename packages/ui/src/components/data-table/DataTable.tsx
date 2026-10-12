import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnOrderState,
  type Header,
  type Row,
  type RowSelectionState,
  type SortingState,
  type VisibilityState,
} from '@tanstack/react-table';
import { defaultRangeExtractor, observeElementRect, useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Download,
  Rows3,
  Rows4,
  type LucideIcon,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';

import { cx } from '../../lib/cx';
import { formatNumber } from '../../lib/format';
import { defaultLink, type LinkRenderer } from '../../lib/link';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { Button, IconButton } from '../../primitives/Button';
import { Checkbox } from '../../primitives/Checkbox';
import { Skeleton } from '../../primitives/Skeleton';
import { EmptyState } from '../EmptyState';
import { rightAligned, typedCell } from './cells';
import { ColumnChooser } from './ColumnChooser';
import type { TableContext } from './context';
import { SavedViews, type SavedViewsProps } from './SavedViews';

export type Density = 'comfortable' | 'compact';

export type BulkAction = {
  label: string;
  icon?: LucideIcon;
  /** Receives the selected row ids, or `'all'` when the user chose every matching row. */
  onClick: (ids: string[] | 'all') => void;
};

export type DataTableProps<T> = {
  /** Accessible name of the table, e.g. "Register". */
  label: string;
  /** TanStack column definitions; set `meta.type` (spec 09 column types) for alignment and the default cell. */
  columns: ColumnDef<T, never>[];
  data: T[];
  rowId: (row: T) => string;
  /** Accessible name of a row, used for the selection checkbox: "TAX-CL-033, Tax collection at source". */
  rowLabel: (row: T) => string;
  /** Link target of the title cell; clicking anywhere on the row follows it. */
  rowHref?: (row: T) => string;
  renderLink?: LinkRenderer;
  /** Controlled sort (from the URL). Omit both for client-side sorting. */
  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
  /** The server sorts; the table only reports sort changes. */
  manualSorting?: boolean;
  selection?: {
    bulkActions: BulkAction[];
    onChange?: (ids: string[]) => void;
  };
  columnVisibility?: VisibilityState;
  columnOrder?: ColumnOrderState;
  onColumnsChange?: (next: { visibility: VisibilityState; order: ColumnOrderState }) => void;
  density?: Density;
  onDensityChange?: (density: Density) => void;
  /** First load: header plus 8 skeleton rows. */
  loading?: boolean;
  /** A new query is loading: keep rows and show the leaf bar under the header. */
  refetching?: boolean;
  error?: { title?: string; message: string; retry: () => void; errorId?: string };
  /** Shown when there are no rows, usually an EmptyState. */
  empty?: ReactNode;
  /** Matching rows on the server; drives the count, aria-rowcount and "select all". */
  totalCount?: number;
  /** Noun for the count: "424 instances". */
  countNoun?: { one: string; other: string };
  /** The saved-view menu (spec 09 §Saved views), first in the toolbar. */
  views?: SavedViewsProps;
  /** Extra toolbar content before the count. */
  toolbarStart?: ReactNode;
  /** `false` hides the toolbar (small embedded tables, e.g. on the overview); the bulk bar still shows. */
  toolbar?: boolean;
  onExport?: () => void;
  /** Height of the scroll area. */
  maxHeight?: number;
  className?: string;
};

const ROW_HEIGHT: Record<Density, number> = { comfortable: 44, compact: 36 };
const HEADER_HEIGHT = 40;
const SELECT_WIDTH = 44;

/**
 * Spec 09 · DataTable. TanStack Table for state and TanStack Virtual for rows, inside a card that scrolls both ways.
 * A semantic table with aria-rowcount and aria-rowindex, so screen readers know the size while rows are virtual.
 */
export function DataTable<T>({
  label,
  columns,
  data,
  rowId,
  rowLabel,
  rowHref,
  renderLink = defaultLink,
  sorting: sortingProp,
  onSortingChange,
  manualSorting = false,
  selection,
  columnVisibility: visibilityProp,
  columnOrder: orderProp,
  onColumnsChange,
  density: densityProp,
  onDensityChange,
  loading = false,
  refetching = false,
  error,
  empty,
  totalCount,
  countNoun = { one: 'row', other: 'rows' },
  views,
  toolbarStart,
  toolbar: showToolbar = true,
  onExport,
  maxHeight = 600,
  className,
}: DataTableProps<T>) {
  const sm = useMediaQuery('(min-width: 640px)', true);
  const [sortingState, setSortingState] = useState<SortingState>([]);
  const sorting = sortingProp ?? sortingState;
  const [visibilityState, setVisibilityState] = useState<VisibilityState>({});
  const [orderState, setOrderState] = useState<ColumnOrderState>([]);
  const visibility = visibilityProp ?? visibilityState;
  const order = orderProp ?? orderState;
  const [densityState, setDensityState] = useState<Density>('comfortable');
  // Touch screens always get comfortable rows.
  const density: Density = sm ? (densityProp ?? densityState) : 'comfortable';
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [allMatching, setAllMatching] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const anchor = useRef<number | null>(null);
  const focusPending = useRef(false);
  /** When an open focus request gives up (performance.now() ms). */
  const focusDeadline = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tbodyRef = useRef<HTMLTableSectionElement>(null);

  const setColumns = (next: { visibility: VisibilityState; order: ColumnOrderState }) => {
    if (!visibilityProp) setVisibilityState(next.visibility);
    if (!orderProp) setOrderState(next.order);
    onColumnsChange?.(next);
  };

  const renderTitle = useCallback<TableContext<T>['renderTitle']>(
    (row, title, sub) => {
      const props = {
        'data-row-link': '',
        tabIndex: row.id === activeRowIdRef.current ? 0 : -1,
        className:
          'line-clamp-1 rounded-tag text-body-strong text-ink hover:underline focus-visible:underline',
        children: title,
        onClick: (e: MouseEvent) => e.stopPropagation(),
      };
      return (
        <span className="flex min-w-0 flex-col">
          {rowHref ? (
            renderLink({ href: rowHref(row.original), ...props })
          ) : (
            <span {...props} role="link" aria-disabled>
              {title}
            </span>
          )}
          {sub ? <span className="truncate text-meta text-muted">{sub}</span> : null}
        </span>
      );
    },
    [rowHref, renderLink],
  );
  // Read during render of the title cell; kept in a ref so cells stay pure functions of the row.
  // activeIndex is a display position (after sorting); cells compare row ids, since row.index is the source position.
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const activeRowIdRef = useRef<string | undefined>(undefined);

  const table = useReactTable<T>({
    data,
    columns: columns as ColumnDef<T, unknown>[],
    getRowId: (row) => rowId(row),
    defaultColumn: { cell: typedCell, size: 160, minSize: 64 },
    state: { sorting, columnVisibility: visibility, columnOrder: order, rowSelection },
    onSortingChange: (updater) => {
      const next = typeof updater === 'function' ? updater(sorting) : updater;
      // A new order: the Tab stop goes back to the first row and the Shift-select anchor no longer applies.
      setActiveIndex(0);
      anchor.current = null;
      if (!sortingProp) setSortingState(next);
      onSortingChange?.(next);
    },
    onRowSelectionChange: (updater) => {
      const next = typeof updater === 'function' ? updater(rowSelection) : updater;
      setRowSelection(next);
      setAllMatching(false);
      selection?.onChange?.(Object.keys(next).filter((k) => next[k]));
    },
    enableRowSelection: !!selection,
    enableSortingRemoval: true,
    sortDescFirst: false,
    manualSorting,
    columnResizeMode: 'onChange',
    enableColumnResizing: true,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: manualSorting ? undefined : getSortedRowModel(),
    meta: {
      renderTitle,
      rowTabIndex: (row) => (row.id === activeRowIdRef.current ? 0 : -1),
    } satisfies TableContext<T>,
  });

  const rows = table.getRowModel().rows;
  // Keep the active position inside the rows (data can shrink) and name the row that owns the Tab stop.
  if (activeIndexRef.current > rows.length - 1)
    activeIndexRef.current = Math.max(0, rows.length - 1);
  activeRowIdRef.current = rows[activeIndexRef.current]?.id;
  const rowHeight = ROW_HEIGHT[density];
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
    scrollPaddingStart: HEADER_HEIGHT,
    // Keep the focused row rendered even when it scrolls out of view, so focus is never lost.
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      const active = activeIndexRef.current;
      if (active < range.count && !indexes.includes(active)) indexes.push(active);
      return indexes.sort((a, b) => a - b);
    },
    // Before layout (and in tests) the area measures 0; assume the full scroll area is visible.
    initialRect: { width: 1280, height: maxHeight },
    observeElementRect: (instance, cb) =>
      observeElementRect(instance, (rect) =>
        cb(rect.height > 0 ? rect : { width: rect.width, height: maxHeight }),
      ),
  });
  useEffect(() => virtualizer.measure(), [virtualizer, rowHeight]);

  // Selection only ever holds rows that are present: when the data changes (a filter, a refetch), drop the rest, so a
  // bulk action can never reach a row the user can no longer see. "All matching" ends when the matching set changes.
  const selectionRef = useRef(rowSelection);
  selectionRef.current = rowSelection;
  const rowIdRef = useRef(rowId);
  rowIdRef.current = rowId;
  useEffect(() => {
    const present = new Set(data.map((d) => rowIdRef.current(d)));
    const selected = Object.keys(selectionRef.current).filter((k) => selectionRef.current[k]);
    const kept = selected.filter((k) => present.has(k));
    if (kept.length !== selected.length)
      table.setRowSelection(Object.fromEntries(kept.map((k) => [k, true])));
  }, [data, table]);
  const lastTotal = useRef(totalCount);
  useEffect(() => {
    if (lastTotal.current !== totalCount) setAllMatching(false);
    lastTotal.current = totalCount;
  }, [totalCount]);
  const selectedIds = Object.keys(rowSelection).filter((k) => rowSelection[k]);
  const total = totalCount ?? data.length;
  const visibleColumns = table.getVisibleLeafColumns();
  const firstDataColumn = visibleColumns[0]?.id;
  const tableWidth = visibleColumns.reduce((w, c) => w + c.getSize(), selection ? SELECT_WIDTH : 0);

  // Move focus to the active row's link after keyboard navigation (it may have just been rendered).
  // While the virtual list scrolls, the row can be rendered many frames later (a jump of thousands of rows on a busy
  // machine), so keep the request open across renders and frames until focus lands, for up to 2 seconds of time rather
  // than a frame count, which a slow machine burns through before the row exists.
  useEffect(() => {
    if (!focusPending.current) return;
    const tryFocus = () => {
      if (!focusPending.current) return;
      const link = tbodyRef.current?.querySelector<HTMLElement>(
        `[data-row-index="${activeIndexRef.current}"] [data-row-link]`,
      );
      link?.focus();
      if (link && document.activeElement === link) focusPending.current = false;
      else if (performance.now() < focusDeadline.current) requestAnimationFrame(tryFocus);
      else focusPending.current = false;
    };
    tryFocus();
  });

  const goTo = (index: number) => {
    const i = Math.max(0, Math.min(rows.length - 1, index));
    focusPending.current = true;
    focusDeadline.current = performance.now() + 2000;
    setActiveIndex(i);
    virtualizer.scrollToIndex(i, { align: 'auto' });
  };

  const selectRange = (to: number) => {
    const from = anchor.current ?? to;
    const [a, b] = from < to ? [from, to] : [to, from];
    const next = { ...rowSelection };
    for (let i = a; i <= b; i += 1) next[rows[i]!.id] = true;
    table.setRowSelection(next);
  };

  const onBodyKeyDown = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>('[data-row-index]');
    if (!rowEl) return;
    const index = Number(rowEl.dataset.rowIndex);
    const onLink = (e.target as HTMLElement).hasAttribute('data-row-link');
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        goTo(index + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        goTo(index - 1);
        break;
      case 'Home':
        e.preventDefault();
        goTo(0);
        break;
      case 'End':
        e.preventDefault();
        goTo(rows.length - 1);
        break;
      case ' ':
        if (!selection || !onLink) return;
        e.preventDefault();
        if (e.shiftKey) selectRange(index);
        else {
          rows[index]!.toggleSelected();
          anchor.current = index;
        }
        break;
      case 'a':
      case 'A':
        if (!selection || !(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        table.toggleAllRowsSelected(true);
        break;
    }
  };

  const onRowClick = (e: MouseEvent<HTMLTableRowElement>, index: number) => {
    if ((e.target as HTMLElement).closest('a, button, input, [role="checkbox"], [role="menuitem"]'))
      return;
    setActiveIndex(index);
    e.currentTarget.querySelector<HTMLElement>('a[data-row-link]')?.click();
  };

  const toolbar = (
    <div className="flex min-h-[52px] flex-wrap items-center gap-2 border-b border-line px-3 py-2">
      {selectedIds.length > 0 && selection ? (
        <BulkBar
          count={allMatching ? total : selectedIds.length}
          loaded={rows.length}
          total={total}
          allLoadedSelected={selectedIds.length === rows.length}
          allMatching={allMatching}
          onSelectAllMatching={() => setAllMatching(true)}
          onClear={() => table.resetRowSelection()}
          actions={selection.bulkActions}
          ids={allMatching ? 'all' : selectedIds}
        />
      ) : (
        <>
          {views ? <SavedViews {...views} /> : null}
          {toolbarStart}
          <span className="text-meta text-muted tabular">
            {loading
              ? 'Loading…'
              : `${formatNumber(total)} ${total === 1 ? countNoun.one : countNoun.other}`}
          </span>
          <span className="flex-1" />
          {sm ? (
            <IconButton
              label={density === 'compact' ? 'Comfortable rows' : 'Compact rows'}
              icon={density === 'compact' ? Rows3 : Rows4}
              variant="ghost"
              onClick={() => {
                const next = density === 'compact' ? 'comfortable' : 'compact';
                setDensityState(next);
                onDensityChange?.(next);
              }}
            />
          ) : null}
          <ColumnChooser
            columns={orderedLeafColumns(table.getAllLeafColumns(), order).map((c) => ({
              id: c.id,
              label:
                c.columnDef.meta?.label ??
                (typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id),
              locked: !!c.columnDef.meta?.locked,
            }))}
            visibility={visibility}
            onChange={setColumns}
            onReset={() => setColumns({ visibility: {}, order: [] })}
          />
          {onExport ? (
            <Button size="sm" icon={Download} onClick={onExport}>
              Export
            </Button>
          ) : null}
        </>
      )}
      <span role="status" className="sr-only">
        {selectedIds.length > 0
          ? `${formatNumber(allMatching ? total : selectedIds.length)} selected`
          : ''}
      </span>
    </div>
  );

  const showBody = !loading && !error && rows.length > 0;
  const virtualRows = showBody ? virtualizer.getVirtualItems() : [];
  const padBottom = showBody ? virtualizer.getTotalSize() - (virtualRows.at(-1)?.end ?? 0) : 0;
  const spacer = (key: string, height: number) =>
    height > 0 ? (
      <tr key={key} aria-hidden style={{ height }}>
        <td colSpan={colSpan} className="p-0" />
      </tr>
    ) : null;
  const colSpan = visibleColumns.length + (selection ? 1 : 0);
  const allSelected = table.getIsAllRowsSelected();
  const someSelected = table.getIsSomeRowsSelected();

  const stickyFirst = (id: string) =>
    id === firstDataColumn ? cx('sticky z-[1]', selection ? 'left-[44px]' : 'left-0') : '';

  return (
    <div
      className={cx(
        'flex flex-col overflow-hidden rounded-card border border-line bg-surface',
        className,
      )}
    >
      {showToolbar || selectedIds.length > 0 ? toolbar : null}
      <div
        ref={scrollRef}
        // A keyboard user can scroll the area itself when it overflows sideways.
        tabIndex={-1}
        className="relative overflow-auto"
        style={{ maxHeight, scrollPaddingTop: HEADER_HEIGHT }}
      >
        <table
          aria-label={label}
          aria-rowcount={total + 1}
          aria-busy={loading || refetching || undefined}
          className="table-fixed border-separate border-spacing-0 text-body text-ink"
          style={{ width: Math.max(tableWidth, 0), minWidth: '100%' }}
        >
          <colgroup>
            {selection ? <col style={{ width: SELECT_WIDTH }} /> : null}
            {visibleColumns.map((c) => (
              <col key={c.id} style={{ width: c.getSize() }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-sticky">
            <tr aria-rowindex={1}>
              {selection ? (
                <th scope="col" className={cx(headCell, 'sticky left-0 z-[2] px-0 text-center')}>
                  <Checkbox
                    label="Select all rows"
                    hideLabel
                    checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                    onCheckedChange={(v) => table.toggleAllRowsSelected(v === true)}
                    disabled={!showBody}
                  />
                </th>
              ) : null}
              {table.getHeaderGroups()[0]!.headers.map((h) => (
                <HeaderCell key={h.id} header={h} sticky={stickyFirst(h.column.id)} />
              ))}
            </tr>
            {refetching ? (
              <tr aria-hidden>
                <th colSpan={colSpan} className="relative h-0 p-0">
                  <span className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-sage">
                    <span className="absolute inset-y-0 w-1/3 bg-leaf animate-[canopy-indeterminate_1.2s_ease-in-out_infinite] motion-reduce:animate-none" />
                  </span>
                </th>
              </tr>
            ) : null}
          </thead>
          <tbody ref={tbodyRef} onKeyDown={onBodyKeyDown}>
            {loading
              ? Array.from({ length: 8 }, (_, i) => (
                  <tr key={i} aria-hidden style={{ height: rowHeight }}>
                    {Array.from({ length: colSpan }, (_, j) => (
                      <td key={j} className={bodyCell}>
                        <Skeleton className="h-3.5 w-3/4" />
                      </td>
                    ))}
                  </tr>
                ))
              : null}
            {error && !loading ? (
              <tr>
                <td colSpan={colSpan}>
                  <EmptyState
                    variant="error"
                    title={error.title ?? `Couldn't load the ${label.toLowerCase()}`}
                    body={error.message}
                    errorId={error.errorId}
                    action={{ label: 'Retry', onClick: error.retry }}
                  />
                </td>
              </tr>
            ) : null}
            {!loading && !error && rows.length === 0 ? (
              <tr>
                <td colSpan={colSpan}>
                  {empty ?? <EmptyState variant="no-results" title="Nothing to show" />}
                </td>
              </tr>
            ) : null}
            {/* One flat keyed list, so a row keeps its DOM node (and focus) when the gaps around it change. */}
            {virtualRows.flatMap((v, i) => {
              const row = rows[v.index]!;
              // Space for the rows that are not rendered before this one.
              const gap = v.start - (i === 0 ? 0 : virtualRows[i - 1]!.end);
              return [
                spacer(`gap-${v.index}`, gap),
                <BodyRow
                  key={row.id}
                  row={row}
                  index={v.index}
                  height={rowHeight}
                  selectable={!!selection}
                  label={rowLabel(row.original)}
                  stickyFirst={stickyFirst}
                  onClick={onRowClick}
                  onSelectClick={(e) => {
                    if (e.shiftKey) {
                      e.preventDefault();
                      selectRange(v.index);
                    } else anchor.current = v.index;
                  }}
                />,
              ];
            })}
            {spacer('end', padBottom)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Leaf columns in display order: the saved order first, then any column it does not mention. */
function orderedLeafColumns<C extends { id: string }>(all: C[], order: ColumnOrderState): C[] {
  if (order.length === 0) return all;
  const byId = new Map(all.map((c) => [c.id, c]));
  const first = order.map((id) => byId.get(id)).filter((c): c is C => !!c);
  return [...first, ...all.filter((c) => !order.includes(c.id))];
}

const headCell =
  'h-10 border-b border-line bg-surface px-3 text-left align-middle text-label uppercase text-muted';
const bodyCell = 'border-t border-line px-3 align-middle';

function HeaderCell<T>({ header, sticky }: { header: Header<T, unknown>; sticky: string }) {
  const column = header.column;
  const type = column.columnDef.meta?.type;
  const sorted = column.getIsSorted();
  const canSort = column.getCanSort() && type !== 'actions';
  const content = flexRender(column.columnDef.header, header.getContext());
  const SortIcon = sorted === 'asc' ? ArrowUp : sorted === 'desc' ? ArrowDown : ArrowUpDown;

  return (
    <th
      scope="col"
      aria-sort={
        sorted === 'asc'
          ? 'ascending'
          : sorted === 'desc'
            ? 'descending'
            : canSort
              ? 'none'
              : undefined
      }
      className={cx(headCell, 'group/th relative', rightAligned(type) && 'text-right', sticky)}
    >
      {canSort ? (
        <button
          type="button"
          onClick={column.getToggleSortingHandler()}
          onKeyDown={(e) => {
            // Alt+Left/Right resizes the column by 16px.
            if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
              e.preventDefault();
              const delta = e.key === 'ArrowLeft' ? -16 : 16;
              header.getContext().table.setColumnSizing((s) => ({
                ...s,
                [column.id]: Math.max(column.columnDef.minSize ?? 64, column.getSize() + delta),
              }));
            }
          }}
          className={cx(
            'inline-flex max-w-full items-center gap-1 rounded-tag uppercase hover:text-ink',
            rightAligned(type) && 'flex-row-reverse',
            sorted && 'text-ink',
          )}
        >
          <span className="truncate">{content}</span>
          <SortIcon
            aria-hidden
            size={14}
            className={cx('shrink-0', !sorted && 'opacity-0 group-hover/th:opacity-100')}
          />
        </button>
      ) : (
        <span className="truncate">
          {type === 'actions' ? <span className="sr-only">{content}</span> : content}
        </span>
      )}
      {column.getCanResize() ? (
        <span
          aria-hidden
          onPointerDown={header.getResizeHandler()}
          onDoubleClick={() => column.resetSize()}
          className="absolute inset-y-2 right-0 w-1.5 cursor-col-resize touch-none rounded-pill hover:bg-line-strong"
        />
      ) : null}
    </th>
  );
}

type BodyRowProps<T> = {
  row: Row<T>;
  index: number;
  height: number;
  selectable: boolean;
  label: string;
  stickyFirst: (id: string) => string;
  onClick: (e: MouseEvent<HTMLTableRowElement>, index: number) => void;
  onSelectClick: (e: MouseEvent) => void;
};

function BodyRow<T>({
  row,
  index,
  height,
  selectable,
  label,
  stickyFirst,
  onClick,
  onSelectClick,
}: BodyRowProps<T>) {
  const selected = row.getIsSelected();
  return (
    <tr
      data-row-index={index}
      aria-rowindex={index + 2}
      onClick={(e) => onClick(e, index)}
      style={{ height }}
      className={cx(
        'group/row cursor-pointer',
        // Focus ring drawn inside the row so sticky cells never hide it.
        'has-[[data-row-link]:focus-visible]:outline-2 has-[[data-row-link]:focus-visible]:-outline-offset-2 has-[[data-row-link]:focus-visible]:outline-forest',
      )}
      data-selected={selected || undefined}
    >
      {selectable ? (
        <td
          className={cx(
            bodyCell,
            'sticky left-0 z-[1] px-0 text-center',
            rowBg,
            // 3px forest bar on the left edge of a selected row.
            selected && 'shadow-[inset_3px_0_0_var(--forest)]',
          )}
          onClickCapture={onSelectClick}
        >
          <Checkbox
            label={`Select ${label}`}
            hideLabel
            checked={selected}
            onCheckedChange={(v) => row.toggleSelected(v === true)}
          />
        </td>
      ) : null}
      {row.getVisibleCells().map((cell) => {
        const type = cell.column.columnDef.meta?.type;
        return (
          <td
            key={cell.id}
            className={cx(
              bodyCell,
              rowBg,
              rightAligned(type) && 'text-right',
              type === 'title' ? 'py-1' : 'whitespace-nowrap',
              stickyFirst(cell.column.id),
              !selectable &&
                selected &&
                cell.column.id === row.getVisibleCells()[0]?.column.id &&
                'shadow-[inset_3px_0_0_var(--forest)]',
            )}
          >
            <div className={cx('min-w-0', type === 'title' ? '' : 'truncate')}>
              {flexRender(cell.column.columnDef.cell, cell.getContext())}
            </div>
          </td>
        );
      })}
    </tr>
  );
}

// Opaque cell backgrounds, so the sticky first column covers what scrolls under it.
const rowBg = 'bg-surface group-hover/row:bg-mist group-data-[selected]/row:bg-neutral-soft';

type BulkBarProps = {
  count: number;
  loaded: number;
  total: number;
  allLoadedSelected: boolean;
  allMatching: boolean;
  onSelectAllMatching: () => void;
  onClear: () => void;
  actions: BulkAction[];
  ids: string[] | 'all';
};

function BulkBar({
  count,
  loaded,
  total,
  allLoadedSelected,
  allMatching,
  onSelectAllMatching,
  onClear,
  actions,
  ids,
}: BulkBarProps) {
  return (
    <>
      <span className="text-body-strong text-ink tabular">{formatNumber(count)} selected</span>
      <Button variant="ghost" size="sm" onClick={onClear}>
        Clear
      </Button>
      {allLoadedSelected && !allMatching && total > loaded ? (
        <Button variant="ghost" size="sm" onClick={onSelectAllMatching}>
          Select all {formatNumber(total)}
        </Button>
      ) : null}
      <span className="flex-1" />
      {actions.map((a) => (
        <Button key={a.label} size="sm" icon={a.icon} onClick={() => a.onClick(ids)}>
          {a.label}
        </Button>
      ))}
    </>
  );
}
