import { Check, ChevronDown } from 'lucide-react';
import { Popover as RadixPopover } from 'radix-ui';
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { cx } from '../lib/cx';
import { controlClasses, Field } from './Field';

export type ComboboxOption = { value: string; label: string; description?: string };

export type ComboboxProps = {
  label: string;
  hideLabel?: boolean;
  helper?: string;
  error?: string;
  options: ComboboxOption[];
  value: string | null;
  onValueChange: (value: string | null) => void;
  placeholder?: string;
  /** Shown when the typed text matches nothing. */
  emptyText?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
};

/**
 * Spec 00 · Combobox. A text field that filters a listbox (ARIA 1.2 combobox pattern). Focus stays in the input;
 * the highlighted option is exposed with aria-activedescendant.
 */
export function Combobox({
  label,
  hideLabel,
  helper,
  error,
  options,
  value,
  onValueChange,
  placeholder,
  emptyText = 'No matches',
  disabled,
  id,
  className,
}: ComboboxProps) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = options.find((o) => o.value === value) ?? null;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  const text = query ?? selected?.label ?? '';
  const filtered = useMemo(() => {
    const q = (query ?? '').trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);

  const openList = (index?: number) => {
    setOpen(true);
    const current = filtered.findIndex((o) => o.value === value);
    setActive(index ?? Math.max(current, 0));
  };

  const close = () => {
    setOpen(false);
    setQuery(null);
  };

  const choose = (option: ComboboxOption) => {
    onValueChange(option.value);
    close();
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const last = filtered.length - 1;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) openList();
        else setActive((i) => Math.min(i + 1, last));
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) openList(last);
        else setActive((i) => Math.max(i - 1, 0));
        break;
      case 'Home':
        if (open) {
          e.preventDefault();
          setActive(0);
        }
        break;
      case 'End':
        if (open) {
          e.preventDefault();
          setActive(last);
        }
        break;
      case 'Enter': {
        const option = filtered[active];
        if (open && option) {
          e.preventDefault();
          choose(option);
        }
        break;
      }
      case 'Escape':
        if (open) {
          e.preventDefault();
          close();
        } else if (value !== null) {
          onValueChange(null);
        }
        break;
      case 'Tab':
        if (open) close();
        break;
    }
  };

  const activeOption = open ? filtered[active] : undefined;
  const optionId = (i: number) => `${listId}-opt-${i}`;

  return (
    <Field
      label={label}
      hideLabel={hideLabel}
      helper={helper}
      error={error}
      id={id}
      className={className}
    >
      {(control) => (
        <RadixPopover.Root
          open={open && !disabled}
          onOpenChange={(o) => (o ? openList() : close())}
        >
          <RadixPopover.Anchor asChild>
            <div className="relative">
              <input
                {...control}
                ref={inputRef}
                role="combobox"
                aria-expanded={open}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={activeOption ? optionId(active) : undefined}
                autoComplete="off"
                disabled={disabled}
                placeholder={placeholder}
                value={text}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                  setOpen(true);
                }}
                onClick={() => (open ? close() : openList())}
                onKeyDown={onKeyDown}
                className={cx(controlClasses(!!error), 'h-control pr-9')}
              />
              <ChevronDown
                aria-hidden
                size={16}
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted"
              />
            </div>
          </RadixPopover.Anchor>
          <RadixPopover.Portal>
            <RadixPopover.Content
              // The popup is the listbox, not a dialog: focus never leaves the input.
              role="presentation"
              align="start"
              sideOffset={4}
              onOpenAutoFocus={(e) => e.preventDefault()}
              onCloseAutoFocus={(e) => e.preventDefault()}
              onInteractOutside={(e) => {
                if (e.target === inputRef.current) e.preventDefault();
              }}
              className="z-popover max-h-72 w-[var(--radix-popover-trigger-width)] min-w-56 overflow-auto rounded-card border border-line bg-surface p-1.5 shadow-overlay"
            >
              <ul id={listId} role="listbox" aria-label={label}>
                {filtered.length === 0 ? (
                  <li role="presentation" className="px-3 py-2 text-body text-muted">
                    {emptyText}
                  </li>
                ) : (
                  filtered.map((o, i) => (
                    <li
                      key={o.value}
                      id={optionId(i)}
                      role="option"
                      aria-selected={o.value === value}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseMove={() => setActive(i)}
                      onClick={() => choose(o)}
                      className={cx(
                        'relative flex min-h-control cursor-pointer flex-col justify-center rounded-[7px] py-1.5 pl-8 pr-3 text-body text-ink',
                        i === active && 'bg-mist',
                      )}
                    >
                      {o.value === value ? (
                        <Check
                          aria-hidden
                          size={16}
                          className="absolute left-2 top-2.5 text-forest"
                        />
                      ) : null}
                      <span>{o.label}</span>
                      {o.description ? (
                        <span className="text-meta text-muted">{o.description}</span>
                      ) : null}
                    </li>
                  ))
                )}
              </ul>
            </RadixPopover.Content>
          </RadixPopover.Portal>
        </RadixPopover.Root>
      )}
    </Field>
  );
}
