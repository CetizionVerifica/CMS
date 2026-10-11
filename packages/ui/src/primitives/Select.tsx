import { Check, ChevronDown } from 'lucide-react';
import { Select as RadixSelect } from 'radix-ui';

import { cx } from '../lib/cx';
import { controlClasses, Field } from './Field';

export type SelectOption = { value: string; label: string; disabled?: boolean };

export type SelectProps = {
  label: string;
  hideLabel?: boolean;
  helper?: string;
  error?: string;
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  name?: string;
  required?: boolean;
  id?: string;
  className?: string;
};

/** Spec 00 · Select. Radix Select styled as an Input; 36px options, the selected one shows a Check. */
export function Select({
  label,
  hideLabel,
  helper,
  error,
  options,
  placeholder = 'Choose…',
  id,
  className,
  ...root
}: SelectProps) {
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
        <RadixSelect.Root {...root}>
          <RadixSelect.Trigger
            {...control}
            className={cx(
              controlClasses(!!error),
              'flex h-control items-center justify-between gap-2 text-left data-[placeholder]:text-muted',
            )}
          >
            <RadixSelect.Value placeholder={placeholder} />
            <RadixSelect.Icon>
              <ChevronDown aria-hidden size={16} className="text-muted" />
            </RadixSelect.Icon>
          </RadixSelect.Trigger>
          <RadixSelect.Portal>
            <RadixSelect.Content
              position="popper"
              sideOffset={4}
              className="z-popover max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-card border border-line bg-surface p-1.5 shadow-overlay"
            >
              <RadixSelect.Viewport>
                {options.map((o) => (
                  <RadixSelect.Item
                    key={o.value}
                    value={o.value}
                    disabled={o.disabled}
                    className="relative flex h-control cursor-pointer select-none items-center rounded-[7px] pl-8 pr-3 text-body text-ink outline-none data-[disabled]:cursor-not-allowed data-[disabled]:text-muted data-[highlighted]:bg-mist"
                  >
                    <RadixSelect.ItemIndicator className="absolute left-2 inline-flex">
                      <Check aria-hidden size={16} className="text-forest" />
                    </RadixSelect.ItemIndicator>
                    <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
                  </RadixSelect.Item>
                ))}
              </RadixSelect.Viewport>
            </RadixSelect.Content>
          </RadixSelect.Portal>
        </RadixSelect.Root>
      )}
    </Field>
  );
}
