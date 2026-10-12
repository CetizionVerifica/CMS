import { ChevronDown } from 'lucide-react';
import { Popover as RadixPopover, ToggleGroup } from 'radix-ui';
import { useId, useRef, useState, type KeyboardEvent } from 'react';

import { cx } from '../lib/cx';
import { monthShort } from '../lib/format';
import {
  fyLabel,
  fyMonths,
  monthName,
  periodLabel,
  periodName,
  quarterLabel,
  quarterMonths,
  type Period,
  type Quarter,
} from '../lib/period';
import { overlayClasses } from '../primitives/Menu';
import { Select } from '../primitives/Select';
import { Tooltip } from '../primitives/Tooltip';

export type { Period, Quarter } from '../lib/period';

type Granularity = 'year' | 'quarter' | 'month';

export type PeriodPickerProps = {
  value: Period;
  /** The web app maps the period to `?fy=…&q=…` or `&m=…`. */
  onChange: (period: Period) => void;
  /** Month the client's FY starts, 1-12. Default 4 (April). */
  fyStartMonth?: number;
  /** FY keys from the client's first FY to the next one, e.g. ["2022-23", "2023-24"]. */
  availableFys: string[];
  /**
   * The current quarter of the current FY, from the engine (the API resolves it in the client's time zone). Drives the
   * "This period" shortcut and the outlined current cell. Omit it to hide both.
   */
  thisPeriod?: Period;
  /** Last month (YYYY-MM) with generated instances; later months and quarters are disabled. */
  availableUntil?: string;
  className?: string;
};

const NOT_GENERATED = 'No instances generated yet';

type Cell = {
  key: string;
  label: string;
  name: string;
  period: Period;
  disabled: boolean;
  selected: boolean;
  current: boolean;
};

/** Spec 03 · PeriodPicker. The sage FY chip and a popover with FY, granularity and a quarter or month grid. */
export function PeriodPicker({
  value,
  onChange,
  fyStartMonth = 4,
  availableFys,
  thisPeriod,
  availableUntil,
  className,
}: PeriodPickerProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<Granularity>(viewOf(value));
  const gridRef = useRef<HTMLDivElement>(null);
  const descId = useId();

  const openWith = (o: boolean) => {
    if (o) {
      setView(viewOf(value));
      // Forget the cell focused last time so reopening lands on the selection.
      setFocusIndex(-1);
    }
    setOpen(o);
  };

  const apply = (p: Period) => {
    onChange(p);
    setOpen(false);
  };

  const changeFy = (fy: string) => {
    if (value.month) {
      const index = fyMonths(value.fy, fyStartMonth).findIndex((m) => m.value === value.month);
      const month = fyMonths(fy, fyStartMonth)[Math.max(index, 0)]!.value;
      onChange({ fy, month });
    } else if (value.quarter) {
      onChange({ fy, quarter: value.quarter });
    } else {
      onChange({ fy });
    }
  };

  const isAfter = (month: string) => !!availableUntil && month > availableUntil;

  const cells: Cell[] =
    view === 'quarter'
      ? ([1, 2, 3, 4] as const).map((q: Quarter) => {
          const p: Period = { fy: value.fy, quarter: q };
          return {
            key: `q${q}`,
            label: quarterLabel(value.fy, q, fyStartMonth),
            name: `Quarter ${q}, ${quarterRange(value.fy, q, fyStartMonth)}`,
            period: p,
            disabled: isAfter(quarterMonths(value.fy, q, fyStartMonth)[0]!.value),
            selected: value.quarter === q && !value.month,
            current: thisPeriod?.fy === value.fy && thisPeriod.quarter === q && !thisPeriod.month,
          };
        })
      : view === 'month'
        ? fyMonths(value.fy, fyStartMonth).map((m) => ({
            key: m.value,
            label: monthShort(m.month),
            name: monthName(m.value),
            period: { fy: value.fy, month: m.value },
            disabled: isAfter(m.value),
            selected: value.month === m.value,
            current: !!thisPeriod && thisPeriodMonths(thisPeriod, fyStartMonth).includes(m.value),
          }))
        : [];

  const enabled = cells.map((c, i) => (c.disabled ? -1 : i)).filter((i) => i >= 0);
  const initialFocus =
    cells.findIndex((c) => c.selected && !c.disabled) >= 0
      ? cells.findIndex((c) => c.selected && !c.disabled)
      : cells.findIndex((c) => c.current && !c.disabled) >= 0
        ? cells.findIndex((c) => c.current && !c.disabled)
        : (enabled[0] ?? -1);
  const [focusIndex, setFocusIndex] = useState(initialFocus);
  const tabIndexCell = enabled.includes(focusIndex) ? focusIndex : initialFocus;
  const columns = view === 'quarter' ? 2 : 3;

  const focusCell = (i: number) => {
    setFocusIndex(i);
    gridRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[i]?.focus();
  };

  const onGridKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const from = tabIndexCell;
    const step = (delta: number) => {
      let i = from + delta;
      while (i >= 0 && i < cells.length && cells[i]!.disabled) i += delta > 0 ? 1 : -1;
      if (i >= 0 && i < cells.length) focusCell(i);
    };
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        step(1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        step(-1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        step(columns);
        break;
      case 'ArrowUp':
        e.preventDefault();
        step(-columns);
        break;
      case 'Home':
        e.preventDefault();
        if (enabled.length) focusCell(enabled[0]!);
        break;
      case 'End':
        e.preventDefault();
        if (enabled.length) focusCell(enabled[enabled.length - 1]!);
        break;
    }
  };

  return (
    <RadixPopover.Root open={open} onOpenChange={openWith}>
      <RadixPopover.Trigger asChild>
        <button
          type="button"
          aria-label={`Period: ${periodName(value)}, change period`}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              openWith(true);
            }
          }}
          className={cx(
            'inline-flex h-control max-w-full items-center gap-1.5 whitespace-nowrap rounded-chip border border-transparent bg-sage px-[11px] text-body-strong text-forest tabular touch-target',
            'transition-colors duration-fast ease-out hover:border-forest data-[state=open]:border-forest',
            className,
          )}
        >
          <span className="truncate">{periodLabel(value)}</span>
          <ChevronDown aria-hidden size={16} className="shrink-0" />
        </button>
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          aria-label="Choose period"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          onOpenAutoFocus={(e) => {
            const cell = gridRef.current?.querySelector<HTMLButtonElement>('[tabindex="0"]');
            if (cell) {
              e.preventDefault();
              cell.focus();
            }
          }}
          className={cx(
            overlayClasses,
            'flex w-[300px] max-w-[calc(100vw-16px)] flex-col gap-3 p-3',
          )}
        >
          <Select
            label="Financial year"
            options={availableFys.map((fy) => ({ value: fy, label: fyLabel(fy) }))}
            value={value.fy}
            onValueChange={changeFy}
          />

          <ToggleGroup.Root
            type="single"
            aria-label="Show"
            value={view}
            onValueChange={(v) => {
              if (!v) return;
              const next = v as Granularity;
              if (next === 'year') apply({ fy: value.fy });
              else {
                setView(next);
                setFocusIndex(-1);
              }
            }}
            className="grid grid-cols-3 gap-0.5 rounded-control bg-neutral-soft p-0.5"
          >
            {(['year', 'quarter', 'month'] as const).map((g) => (
              <ToggleGroup.Item
                key={g}
                value={g}
                className={cx(
                  'h-8 rounded-[7px] text-meta text-muted touch-target',
                  'data-[state=on]:bg-surface data-[state=on]:text-ink data-[state=on]:shadow-[0_0_0_1px_var(--line)]',
                )}
              >
                {g === 'year' ? 'Year' : g === 'quarter' ? 'Quarter' : 'Month'}
              </ToggleGroup.Item>
            ))}
          </ToggleGroup.Root>

          {view !== 'year' ? (
            <div
              ref={gridRef}
              role="radiogroup"
              aria-label={view === 'quarter' ? 'Quarter' : 'Month'}
              onKeyDown={onGridKeyDown}
              className={cx('grid gap-1.5', view === 'quarter' ? 'grid-cols-2' : 'grid-cols-3')}
            >
              <span id={descId} hidden>
                {NOT_GENERATED}
              </span>
              {cells.map((c, i) => {
                const cell = (
                  <button
                    key={c.key}
                    type="button"
                    role="radio"
                    aria-checked={c.selected}
                    aria-label={c.name}
                    aria-disabled={c.disabled || undefined}
                    aria-describedby={c.disabled ? descId : undefined}
                    tabIndex={i === tabIndexCell ? 0 : -1}
                    onFocus={() => !c.disabled && setFocusIndex(i)}
                    // A disabled cell never takes focus, so the roving focus stays on a cell that can be chosen.
                    onMouseDown={(e) => c.disabled && e.preventDefault()}
                    onClick={() => !c.disabled && apply(c.period)}
                    className={cx(
                      'rounded-control border text-body-strong touch-target',
                      view === 'quarter' ? 'h-11' : 'h-control',
                      c.selected
                        ? 'border-forest bg-forest text-on-forest'
                        : c.current
                          ? 'border-forest bg-surface text-ink'
                          : 'border-line bg-surface text-ink hover:border-line-strong',
                      c.disabled &&
                        'cursor-not-allowed border-line bg-mist text-muted hover:border-line',
                    )}
                  >
                    {c.label}
                  </button>
                );
                return c.disabled ? (
                  <Tooltip key={c.key} content={NOT_GENERATED}>
                    {cell}
                  </Tooltip>
                ) : (
                  cell
                );
              })}
            </div>
          ) : null}

          {thisPeriod ? (
            <div className="border-t border-line pt-2">
              <button
                type="button"
                onClick={() => apply(thisPeriod)}
                className="inline-flex min-h-control items-center rounded-control px-2 text-body-strong text-forest hover:bg-mist touch-target"
              >
                This period
                <span className="sr-only">, {periodName(thisPeriod)}</span>
              </button>
            </div>
          ) : null}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

function viewOf(p: Period): Granularity {
  return p.month ? 'month' : p.quarter ? 'quarter' : 'year';
}

function quarterRange(fy: string, q: Quarter, fyStartMonth: number): string {
  const months = quarterMonths(fy, q, fyStartMonth);
  return `${monthName(months[0]!.value)} to ${monthName(months[2]!.value)}`;
}

function thisPeriodMonths(p: Period, fyStartMonth: number): string[] {
  if (p.month) return [p.month];
  if (p.quarter) return quarterMonths(p.fy, p.quarter, fyStartMonth).map((m) => m.value);
  return [];
}
