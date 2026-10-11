import { Check, Minus } from 'lucide-react';
import {
  Checkbox as RadixCheckbox,
  RadioGroup as RadixRadioGroup,
  Switch as RadixSwitch,
} from 'radix-ui';
import { useId, type ReactNode } from 'react';

import { cx } from '../lib/cx';

// A 16px box inside a 36px hit area (44px on touch): the ::before pseudo-element extends the clickable region.
const hitArea =
  'relative before:absolute before:left-1/2 before:top-1/2 before:size-control before:-translate-x-1/2 before:-translate-y-1/2 ' +
  'pointer-coarse:before:size-control-touch';

export type CheckboxProps = {
  /** Visible label; with `hideLabel` it becomes the accessible name only. */
  label: ReactNode;
  hideLabel?: boolean;
  checked?: boolean | 'indeterminate';
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean | 'indeterminate') => void;
  disabled?: boolean;
  name?: string;
  value?: string;
  id?: string;
  className?: string;
};

/** Spec 00 · Checkbox. 16px box, 1.5px line-strong border, 4px radius; checked forest with white Check; bar when indeterminate. */
export function Checkbox({ label, hideLabel, id, className, ...root }: CheckboxProps) {
  const generated = useId();
  const controlId = id ?? generated;
  return (
    <span className={cx('inline-flex min-h-control items-center gap-2', className)}>
      <RadixCheckbox.Root
        {...root}
        id={controlId}
        className={cx(
          hitArea,
          'inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border-[1.5px] border-line-strong bg-surface text-on-forest',
          'data-[state=checked]:border-forest data-[state=checked]:bg-forest',
          'data-[state=indeterminate]:border-forest data-[state=indeterminate]:bg-forest',
          'disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer',
        )}
      >
        <RadixCheckbox.Indicator className="group inline-flex">
          <Check
            aria-hidden
            size={12}
            strokeWidth={3}
            className="group-data-[state=indeterminate]:hidden"
          />
          <Minus
            aria-hidden
            size={12}
            strokeWidth={3}
            className="hidden group-data-[state=indeterminate]:block"
          />
        </RadixCheckbox.Indicator>
      </RadixCheckbox.Root>
      <label
        htmlFor={controlId}
        className={hideLabel ? 'sr-only' : 'cursor-pointer text-body text-ink'}
      >
        {label}
      </label>
    </span>
  );
}

export type RadioGroupProps = {
  label: string;
  hideLabel?: boolean;
  options: { value: string; label: ReactNode; disabled?: boolean }[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  orientation?: 'horizontal' | 'vertical';
  name?: string;
  className?: string;
};

/** Spec 00 · Radio. Radix RadioGroup; arrow keys move and select, the group is one tab stop. */
export function RadioGroup({
  label,
  hideLabel,
  options,
  orientation = 'vertical',
  className,
  ...root
}: RadioGroupProps) {
  const labelId = useId();
  const base = useId();
  return (
    <div role="group" aria-labelledby={labelId} className={cx('flex flex-col gap-1', className)}>
      <span id={labelId} className={hideLabel ? 'sr-only' : 'text-meta text-ink'}>
        {label}
      </span>
      <RadixRadioGroup.Root
        {...root}
        aria-labelledby={labelId}
        orientation={orientation}
        className={cx(
          'flex gap-x-4',
          orientation === 'vertical' ? 'flex-col' : 'flex-row flex-wrap',
        )}
      >
        {options.map((o, i) => (
          <span key={o.value} className="inline-flex min-h-control items-center gap-2">
            <RadixRadioGroup.Item
              id={`${base}-${i}`}
              value={o.value}
              disabled={o.disabled}
              className={cx(
                hitArea,
                'inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-pill border-[1.5px] border-line-strong bg-surface',
                'data-[state=checked]:border-forest disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              <RadixRadioGroup.Indicator className="size-2 rounded-pill bg-forest" />
            </RadixRadioGroup.Item>
            <label htmlFor={`${base}-${i}`} className="cursor-pointer text-body text-ink">
              {o.label}
            </label>
          </span>
        ))}
      </RadixRadioGroup.Root>
    </div>
  );
}

export type SwitchProps = {
  label: ReactNode;
  hideLabel?: boolean;
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  name?: string;
  id?: string;
  className?: string;
};

/** Spec 00 · Switch. For settings that apply immediately; use a Checkbox inside forms. */
export function Switch({ label, hideLabel, id, className, ...root }: SwitchProps) {
  const generated = useId();
  const controlId = id ?? generated;
  return (
    <span className={cx('inline-flex min-h-control items-center gap-2', className)}>
      <RadixSwitch.Root
        {...root}
        id={controlId}
        className={cx(
          'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-pill border-[1.5px] border-line-strong bg-neutral-soft',
          'transition-colors duration-fast ease-out data-[state=checked]:border-forest data-[state=checked]:bg-forest',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        <RadixSwitch.Thumb className="block size-3.5 translate-x-0.5 rounded-pill bg-line-strong transition-transform duration-fast ease-out data-[state=checked]:translate-x-4 data-[state=checked]:bg-surface" />
      </RadixSwitch.Root>
      <label
        htmlFor={controlId}
        className={hideLabel ? 'sr-only' : 'cursor-pointer text-body text-ink'}
      >
        {label}
      </label>
    </span>
  );
}
