import { ChevronDown, ListFilter, Plus, Search, X } from 'lucide-react';
import { Accordion, Dialog } from 'radix-ui';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { cx } from '../lib/cx';
import { formatDate, formatNumber } from '../lib/format';
import { useMediaQuery } from '../lib/useMediaQuery';
import { Button, IconButton } from '../primitives/Button';
import { Checkbox } from '../primitives/Checkbox';
import { DateInput } from '../primitives/DateInput';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../primitives/Menu';
import { Popover, PopoverContent, PopoverTrigger } from '../primitives/Popover';
import { CRITICALITY_LABEL, CriticalityTag, type Criticality } from './CriticalityTag';
import { categoryLabel, StatusPill, type DerivedStatus } from './StatusPill';

export type FilterOption = { value: string; label: string; count?: number };
export type DateRange = { from?: string; to?: string; preset?: string };
export type FilterValue = string[] | DateRange;

export type FilterDef = {
  key: string;
  label: string;
  kind: 'multi' | 'dateRange';
  /** Values with facet counts from the API. Status and criticality follow enum order. */
  options?: FilterOption[];
  order?: 'given' | 'alpha';
  /** Show each option as a StatusPill or CriticalityTag next to its checkbox. */
  display?: 'status' | 'criticality';
  /** Date presets with ranges the app computed (via the engine), e.g. Overdue, This week. */
  presets?: { value: string; label: string; range: { from?: string; to?: string } }[];
};

export type FilterBarProps = {
  filters: FilterDef[];
  value: Record<string, FilterValue>;
  onChange: (value: Record<string, FilterValue>) => void;
  search?: { value: string; onChange: (q: string) => void; placeholder?: string };
  /** Shown as chips; the rest go under "+ More" until they have a value. */
  primaryKeys?: string[];
  /** Announced politely after changes and used by the phone sheet: "38 instances match". */
  resultText?: string;
  /** Count for the phone sheet's "Show 38 results" button. */
  resultCount?: number;
  /** While the table is in error. */
  disabled?: boolean;
  className?: string;
};

const isActive = (v: FilterValue | undefined) =>
  Array.isArray(v) ? v.length > 0 : !!v && (!!v.from || !!v.to || !!v.preset);

const optionLabel = (def: FilterDef, value: string) => {
  if (def.display === 'status') return categoryLabel(value as DerivedStatus).full;
  if (def.display === 'criticality') return CRITICALITY_LABEL[value as Criticality];
  return def.options?.find((o) => o.value === value)?.label ?? value;
};

/** "Overdue, Due soon" (max two values), then "Overdue +2". */
export function summarise(def: FilterDef, v: FilterValue): string {
  if (Array.isArray(v)) {
    const labels = v.map((x) => optionLabel(def, x));
    return labels.length <= 2 ? labels.join(', ') : `${labels[0]} +${labels.length - 1}`;
  }
  if (v.preset) return def.presets?.find((p) => p.value === v.preset)?.label ?? v.preset;
  if (v.from && v.to) return `${formatDate(v.from)} – ${formatDate(v.to)}`;
  if (v.from) return `From ${formatDate(v.from)}`;
  return `Until ${formatDate(v.to!)}`;
}

/**
 * Spec 10 · FilterBar. Controlled: the web app keeps the value in the URL. Chips open a popover of checkboxes (or
 * date presets); values apply as they are ticked. Under 640px it becomes a search field and a "Filters" sheet.
 */
export function FilterBar({
  filters,
  value,
  onChange,
  search,
  primaryKeys,
  resultText,
  resultCount,
  disabled = false,
  className,
}: FilterBarProps) {
  const sm = useMediaQuery('(min-width: 640px)', true);
  const lg = useMediaQuery('(min-width: 1100px)', true);
  const [revealed, setRevealed] = useState<string[]>([]);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const primary = primaryKeys ?? filters.map((f) => f.key);
  // Under 1100px only the first three primary chips stay inline; the rest move under "+ More".
  const inline = lg ? primary : primary.slice(0, 3);
  const chipKeys = filters
    .map((f) => f.key)
    .filter((k) => inline.includes(k) || revealed.includes(k) || isActive(value[k]));
  const moreFilters = filters.filter((f) => !chipKeys.includes(f.key));
  const activeCount = filters.filter((f) => isActive(value[f.key])).length;

  const set = (key: string, v: FilterValue | undefined) => {
    const next = { ...value };
    if (v === undefined || !isActive(v)) delete next[key];
    else next[key] = v;
    onChange(next);
  };

  const live = (
    <span role="status" className="sr-only">
      {resultText ?? ''}
    </span>
  );

  if (!sm) {
    return (
      <div role="group" aria-label="Filters" className={cx('flex items-center gap-2', className)}>
        {search ? <SearchField {...search} disabled={disabled} /> : null}
        <FilterSheet
          filters={filters}
          value={value}
          set={set}
          activeCount={activeCount}
          resultCount={resultCount}
          onClearAll={() => onChange({})}
          disabled={disabled}
        />
        {live}
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label="Filters"
      className={cx('flex flex-wrap items-center gap-2', className)}
    >
      {search ? <SearchField {...search} disabled={disabled} /> : null}
      {chipKeys.map((key) => {
        const def = filters.find((f) => f.key === key)!;
        return (
          <FilterChip
            key={key}
            def={def}
            value={value[key]}
            open={openKey === key}
            onOpenChange={(o) => setOpenKey(o ? key : null)}
            onChange={(v) => set(key, v)}
            disabled={disabled}
          />
        );
      })}
      {moreFilters.length > 0 ? (
        <Menu>
          <MenuTrigger asChild>
            <Button size="sm" variant="ghost" icon={Plus} disabled={disabled}>
              More
            </Button>
          </MenuTrigger>
          <MenuContent>
            {moreFilters.map((f) => (
              <MenuItem
                key={f.key}
                onSelect={() => {
                  setRevealed((r) => [...r, f.key]);
                  // Open the new chip once it has rendered.
                  requestAnimationFrame(() => setOpenKey(f.key));
                }}
              >
                {f.label}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      ) : null}
      <span className="flex-1" />
      {activeCount > 0 ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onChange({});
            setRevealed([]);
          }}
          disabled={disabled}
        >
          Clear all
        </Button>
      ) : null}
      {live}
    </div>
  );
}

function SearchField({
  value,
  onChange,
  placeholder = 'Search title, ID or Act',
  disabled,
}: {
  value: string;
  onChange: (q: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value);
  const [shown, setShown] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  if (value !== shown) {
    setShown(value);
    setText(value);
  }
  useEffect(() => () => clearTimeout(timer.current), []);

  const update = (q: string, delay: number) => {
    setText(q);
    clearTimeout(timer.current);
    if (delay === 0) onChange(q);
    else timer.current = setTimeout(() => onChange(q), delay);
  };

  return (
    <div className="relative min-w-0 flex-1 sm:max-w-72 sm:flex-initial">
      <Search
        aria-hidden
        size={16}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
      />
      <input
        type="search"
        aria-label={placeholder}
        placeholder={placeholder}
        value={text}
        disabled={disabled}
        onChange={(e) => update(e.target.value, 250)}
        className="h-control w-full rounded-control border border-line-strong bg-surface pl-9 pr-9 text-body text-ink placeholder:text-muted touch-target [&::-webkit-search-cancel-button]:hidden"
      />
      {text ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => update('', 0)}
          className="absolute right-1 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-control text-muted hover:bg-mist hover:text-ink"
        >
          <X aria-hidden size={16} />
        </button>
      ) : null}
    </div>
  );
}

type ChipProps = {
  def: FilterDef;
  value: FilterValue | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (v: FilterValue | undefined) => void;
  disabled: boolean;
};

function FilterChip({ def, value, open, onOpenChange, onChange, disabled }: ChipProps) {
  const active = isActive(value);
  const summary = active ? summarise(def, value!) : '';
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <span
        className={cx(
          'inline-flex h-control-compact items-center rounded-pill border text-meta',
          active
            ? 'border-transparent bg-sage pl-3 pr-1 font-bold text-forest'
            : 'border-line-strong bg-surface px-3 text-ink hover:border-forest',
          disabled && 'opacity-50',
        )}
      >
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            disabled={disabled}
            aria-label={active ? `${def.label} filter: ${summary}. Change` : undefined}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                onOpenChange(true);
              }
              if (e.key === 'Backspace' && active) {
                e.preventDefault();
                onChange(undefined);
              }
            }}
            className="inline-flex h-full max-w-64 items-center gap-1 rounded-pill outline-offset-2 touch-target disabled:cursor-not-allowed"
          >
            <span className="truncate">{active ? `${def.label}: ${summary}` : def.label}</span>
            {active ? null : <ChevronDown aria-hidden size={16} className="shrink-0" />}
          </button>
        </PopoverTrigger>
        {active ? (
          <button
            type="button"
            aria-label={`Remove ${def.label.toLowerCase()} filter`}
            disabled={disabled}
            onClick={() => {
              onChange(undefined);
              triggerRef.current?.focus();
            }}
            className="ml-0.5 inline-flex size-6 items-center justify-center rounded-pill hover:bg-on-forest-hover touch-target"
          >
            <X aria-hidden size={14} />
          </button>
        ) : null}
      </span>
      <PopoverContent
        aria-label={`${def.label} filter`}
        className="flex w-[280px] flex-col gap-2 p-2"
      >
        <FilterPanel def={def} value={value} onChange={onChange} />
        <div className="flex justify-between border-t border-line pt-2">
          <Button size="sm" variant="ghost" onClick={() => onChange(undefined)} disabled={!active}>
            Clear
          </Button>
          <Button size="sm" variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The options of one filter: checkboxes for multi, presets and dates for a range. Shared by chip and sheet. */
function FilterPanel({
  def,
  value,
  onChange,
}: {
  def: FilterDef;
  value: FilterValue | undefined;
  onChange: (v: FilterValue | undefined) => void;
}) {
  const [query, setQuery] = useState('');
  const listRef = useRef<HTMLUListElement>(null);

  if (def.kind === 'dateRange') {
    const range = (value as DateRange | undefined) ?? {};
    return (
      <div className="flex flex-col gap-2">
        {def.presets?.length ? (
          <ul aria-label="Presets" className="flex flex-col">
            {def.presets.map((p) => (
              <li key={p.value}>
                <Checkbox
                  label={p.label}
                  checked={range.preset === p.value}
                  onCheckedChange={(c) =>
                    onChange(c === true ? { ...p.range, preset: p.value } : undefined)
                  }
                />
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-meta text-muted">Custom range</p>
        <DateInput
          label="From"
          value={range.preset ? null : (range.from ?? null)}
          max={range.preset ? undefined : range.to}
          onValueChange={(from) =>
            onChange({ ...(range.preset ? {} : range), preset: undefined, from: from ?? undefined })
          }
          helper=""
        />
        <DateInput
          label="To"
          value={range.preset ? null : (range.to ?? null)}
          min={range.preset ? undefined : range.from}
          onValueChange={(to) =>
            onChange({ ...(range.preset ? {} : range), preset: undefined, to: to ?? undefined })
          }
          helper=""
        />
      </div>
    );
  }

  const selected = (value as string[] | undefined) ?? [];
  const options = [...(def.options ?? [])];
  if (def.order === 'alpha') options.sort((a, b) => a.label.localeCompare(b.label));
  const q = query.trim().toLowerCase();
  const shown = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;

  const toggle = (v: string, on: boolean) => {
    const next = on ? [...selected, v] : selected.filter((x) => x !== v);
    // Keep the API's option order, not the click order.
    onChange(options.map((o) => o.value).filter((x) => next.includes(x)));
  };

  // ArrowUp/Down move between the checkboxes; Space toggles (native to the checkbox).
  const onListKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const boxes = [
      ...(listRef.current?.querySelectorAll<HTMLElement>('button[role="checkbox"]') ?? []),
    ];
    const i = boxes.indexOf(document.activeElement as HTMLElement);
    const next = boxes[i + (e.key === 'ArrowDown' ? 1 : -1)];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  const renderLabel = (o: FilterOption): ReactNode =>
    def.display === 'status' ? (
      <StatusPill status={o.value as DerivedStatus} size="sm" category />
    ) : def.display === 'criticality' ? (
      <CriticalityTag level={o.value as Criticality} size="sm" />
    ) : (
      o.label
    );

  return (
    <div className="flex flex-col gap-1">
      {options.length > 8 ? (
        <input
          aria-label={`Search ${def.label.toLowerCase()}`}
          placeholder={`Search ${def.label.toLowerCase()}`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              listRef.current?.querySelector<HTMLElement>('button[role="checkbox"]')?.focus();
            }
          }}
          className="h-control w-full rounded-control border border-line-strong bg-surface px-3 text-body text-ink placeholder:text-muted touch-target"
        />
      ) : null}
      <ul
        ref={listRef}
        aria-label={def.label}
        onKeyDown={onListKeyDown}
        className="flex max-h-72 flex-col overflow-y-auto"
      >
        {shown.length === 0 ? (
          <li className="px-2 py-2 text-body text-muted">
            No {def.label.toLowerCase()} matches “{query.trim()}”.
          </li>
        ) : (
          shown.map((o) => (
            <li
              key={o.value}
              className="flex items-center justify-between gap-2 rounded-[7px] px-1 hover:bg-mist"
            >
              <Checkbox
                label={<span className="inline-flex items-center gap-2">{renderLabel(o)}</span>}
                checked={selected.includes(o.value)}
                onCheckedChange={(c) => toggle(o.value, c === true)}
                className="min-w-0 flex-1"
              />
              {o.count !== undefined ? (
                <span className="shrink-0 text-meta text-muted tabular">
                  {formatNumber(o.count)}
                </span>
              ) : null}
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function FilterSheet({
  filters,
  value,
  set,
  activeCount,
  resultCount,
  onClearAll,
  disabled,
}: {
  filters: FilterDef[];
  value: Record<string, FilterValue>;
  set: (key: string, v: FilterValue | undefined) => void;
  activeCount: number;
  resultCount?: number;
  onClearAll: () => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button size="md" icon={ListFilter} disabled={disabled} className="shrink-0">
          {activeCount > 0 ? `Filters (${activeCount})` : 'Filters'}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-dialog bg-scrim" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-x-0 bottom-0 z-dialog flex max-h-[90vh] flex-col rounded-t-card bg-surface shadow-overlay"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-2">
            <Dialog.Title className="text-section text-ink">Filters</Dialog.Title>
            <div className="flex items-center gap-1">
              {activeCount > 0 ? (
                <Button size="sm" variant="ghost" onClick={onClearAll}>
                  Clear all
                </Button>
              ) : null}
              <Dialog.Close asChild>
                <IconButton label="Close" icon={X} variant="ghost" hideTooltip />
              </Dialog.Close>
            </div>
          </div>
          <Accordion.Root type="multiple" className="min-h-0 flex-1 overflow-y-auto px-4">
            {filters.map((f) => {
              const v = value[f.key];
              return (
                <Accordion.Item key={f.key} value={f.key} className="border-b border-line">
                  <Accordion.Header>
                    <Accordion.Trigger className="group flex min-h-11 w-full items-center justify-between gap-2 text-left text-body-strong text-ink">
                      <span className="min-w-0">
                        {f.label}
                        {isActive(v) ? (
                          <span className="block truncate text-meta font-semibold text-forest">
                            {summarise(f, v!)}
                          </span>
                        ) : null}
                      </span>
                      <ChevronDown
                        aria-hidden
                        size={16}
                        className="shrink-0 transition-transform group-data-[state=open]:rotate-180"
                      />
                    </Accordion.Trigger>
                  </Accordion.Header>
                  <Accordion.Content className="pb-3">
                    <FilterPanel def={f} value={v} onChange={(nv) => set(f.key, nv)} />
                  </Accordion.Content>
                </Accordion.Item>
              );
            })}
          </Accordion.Root>
          <div className="sticky bottom-0 border-t border-line bg-surface p-4">
            <Dialog.Close asChild>
              <Button variant="primary" className="w-full">
                {resultCount === undefined
                  ? 'Show results'
                  : `Show ${formatNumber(resultCount)} ${resultCount === 1 ? 'result' : 'results'}`}
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
