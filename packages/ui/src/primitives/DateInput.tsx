import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { Popover as RadixPopover } from 'radix-ui';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import {
  addDays,
  addMonths,
  monthWeeks,
  parseDateInput,
  parts,
  toIso,
  weekdayMon0,
} from '../lib/calendarDate';
import { cx } from '../lib/cx';
import { formatDate, monthLong } from '../lib/format';
import { IconButton } from './Button';
import { controlClasses, Field } from './Field';
import { overlayClasses } from './Menu';

export type DateInputProps = {
  label: string;
  hideLabel?: boolean;
  helper?: string;
  /** An error from the form; the input adds its own for text it cannot read. */
  error?: string;
  /** Calendar date, YYYY-MM-DD, or null when empty. */
  value: string | null;
  onValueChange: (value: string | null) => void;
  /** Earliest and latest allowed dates, YYYY-MM-DD. */
  min?: string;
  max?: string;
  /** Today in the client's time zone (YYYY-MM-DD), to mark it in the calendar and open there when empty. */
  today?: string;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
  className?: string;
};

const WEEKDAYS = [
  ['Mo', 'Monday'],
  ['Tu', 'Tuesday'],
  ['We', 'Wednesday'],
  ['Th', 'Thursday'],
  ['Fr', 'Friday'],
  ['Sa', 'Saturday'],
  ['Su', 'Sunday'],
] as const;

const longDate = (iso: string) => {
  const { year, month, day } = parts(iso);
  return `${day} ${monthLong(month)} ${year}`;
};

/**
 * Spec 00 · Date input. A text field that reads "31 Mar 2027" or "31/03/2027", plus a calendar in a popover.
 * The value is a calendar date string (YYYY-MM-DD) with no time zone.
 */
export function DateInput({
  label,
  hideLabel,
  helper,
  error,
  value,
  onValueChange,
  min,
  max,
  today,
  disabled,
  required,
  name,
  id,
  className,
}: DateInputProps) {
  const [text, setText] = useState(value ? formatDate(value) : '');
  const [shown, setShown] = useState(value);
  const [ownError, setOwnError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Follow the value when the form changes it.
  if (value !== shown) {
    setShown(value);
    setText(value ? formatDate(value) : '');
    setOwnError(null);
  }

  const outOfRange = (iso: string) => (!!min && iso < min) || (!!max && iso > max);
  const rangeMessage =
    min && max
      ? `Choose a date between ${formatDate(min)} and ${formatDate(max)}.`
      : min
        ? `Choose ${formatDate(min)} or later.`
        : `Choose ${formatDate(max ?? '')} or earlier.`;

  const commit = (iso: string | null) => {
    setOwnError(null);
    setShown(iso);
    setText(iso ? formatDate(iso) : '');
    if (iso !== value) onValueChange(iso);
  };

  const commitText = () => {
    const t = text.trim();
    if (!t) return commit(null);
    const iso = parseDateInput(t);
    if (!iso) return setOwnError('Enter a date like 31 Mar 2027.');
    if (outOfRange(iso)) return setOwnError(rangeMessage);
    commit(iso);
  };

  return (
    <Field
      label={label}
      hideLabel={hideLabel}
      helper={helper ?? 'For example 31 Mar 2027'}
      error={ownError ?? error}
      id={id}
      className={className}
    >
      {(control) => (
        <RadixPopover.Root open={open && !disabled} onOpenChange={setOpen}>
          <div className="flex gap-2">
            <input
              {...control}
              name={name}
              required={required}
              disabled={disabled}
              autoComplete="off"
              inputMode="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={commitText}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitText();
                if (e.key === 'ArrowDown' && e.altKey) {
                  e.preventDefault();
                  setOpen(true);
                }
              }}
              className={cx(controlClasses(!!(ownError ?? error)), 'h-control')}
            />
            <RadixPopover.Trigger asChild>
              <IconButton
                label={`Choose ${label.toLowerCase()} from calendar`}
                icon={CalendarDays}
                variant="secondary"
                disabled={disabled}
                hideTooltip
              />
            </RadixPopover.Trigger>
          </div>
          <RadixPopover.Portal>
            <RadixPopover.Content
              aria-label={`Choose ${label.toLowerCase()}`}
              align="end"
              sideOffset={6}
              collisionPadding={8}
              onOpenAutoFocus={(e) => e.preventDefault()}
              className={cx(overlayClasses, 'p-3')}
            >
              <Calendar
                selected={value}
                today={today}
                isDisabled={outOfRange}
                onSelect={(iso) => {
                  commit(iso);
                  setOpen(false);
                }}
              />
            </RadixPopover.Content>
          </RadixPopover.Portal>
        </RadixPopover.Root>
      )}
    </Field>
  );
}

type CalendarProps = {
  selected: string | null;
  today?: string;
  isDisabled: (iso: string) => boolean;
  onSelect: (iso: string) => void;
};

/** Month grid (ARIA grid pattern). Arrows move by day and week, Page Up/Down by month, Home/End to the week's ends. */
function Calendar({ selected, today, isDisabled, onSelect }: CalendarProps) {
  const headingId = useId();
  const [focused, setFocused] = useState(() => selected ?? today ?? browserToday());
  const gridRef = useRef<HTMLTableElement>(null);
  // Focus follows the active day on open and after keyboard moves, not after the month buttons.
  const moveFocus = useRef(true);

  useEffect(() => {
    if (!moveFocus.current) return;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${focused}"]`)?.focus();
    moveFocus.current = false;
  }, [focused]);

  const { year, month } = parts(focused);
  const weeks = monthWeeks(focused);

  const onKeyDown = (e: KeyboardEvent<HTMLTableElement>) => {
    const moves: Record<string, () => string> = {
      ArrowRight: () => addDays(focused, 1),
      ArrowLeft: () => addDays(focused, -1),
      ArrowDown: () => addDays(focused, 7),
      ArrowUp: () => addDays(focused, -7),
      PageDown: () => addMonths(focused, e.shiftKey ? 12 : 1),
      PageUp: () => addMonths(focused, e.shiftKey ? -12 : -1),
      Home: () => addDays(focused, -weekdayMon0(focused)),
      End: () => addDays(focused, 6 - weekdayMon0(focused)),
    };
    const move = moves[e.key];
    if (move) {
      e.preventDefault();
      moveFocus.current = true;
      setFocused(move());
    }
  };

  return (
    <div className="flex w-[280px] flex-col gap-2">
      <div className="flex items-center justify-between">
        <IconButton
          label="Previous month"
          icon={ChevronLeft}
          variant="ghost"
          size="sm"
          hideTooltip
          onClick={() => setFocused(addMonths(focused, -1))}
        />
        <h2 id={headingId} aria-live="polite" className="text-body-strong text-ink">
          {monthLong(month)} {year}
        </h2>
        <IconButton
          label="Next month"
          icon={ChevronRight}
          variant="ghost"
          size="sm"
          hideTooltip
          onClick={() => setFocused(addMonths(focused, 1))}
        />
      </div>
      <table
        ref={gridRef}
        role="grid"
        aria-labelledby={headingId}
        onKeyDown={onKeyDown}
        className="w-full border-collapse"
      >
        <thead>
          <tr>
            {WEEKDAYS.map(([short, full]) => (
              <th key={short} scope="col" abbr={full} className="h-8 text-meta text-muted">
                {short}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week.find(Boolean)}>
              {week.map((iso, i) =>
                iso ? (
                  <td key={iso} role="gridcell" aria-selected={iso === selected} className="p-0.5">
                    <button
                      type="button"
                      data-date={iso}
                      tabIndex={iso === focused ? 0 : -1}
                      aria-label={longDate(iso)}
                      aria-current={iso === today ? 'date' : undefined}
                      aria-disabled={isDisabled(iso) || undefined}
                      onClick={() => !isDisabled(iso) && onSelect(iso)}
                      onFocus={() => iso !== focused && setFocused(iso)}
                      className={cx(
                        'size-9 rounded-control text-body tabular',
                        iso === selected
                          ? 'bg-forest font-bold text-on-forest'
                          : isDisabled(iso)
                            ? 'cursor-not-allowed text-muted line-through'
                            : 'text-ink hover:bg-mist',
                        iso === today && iso !== selected && 'border border-forest',
                      )}
                    >
                      {parts(iso).day}
                    </button>
                  </td>
                ) : (
                  <td key={`blank-${i}`} className="p-0.5" />
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Only for where the calendar opens when there is no value and no `today`; never stored. */
function browserToday(): string {
  const d = new Date();
  return toIso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}
