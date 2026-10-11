import { LoaderCircle, type LucideIcon } from 'lucide-react';
import { Slot } from 'radix-ui';
import { useId, type ComponentPropsWithRef, type MouseEvent } from 'react';

import { cx } from '../lib/cx';
import { Tooltip } from './Tooltip';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm';

const base =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-control text-body font-bold ' +
  'transition-colors duration-fast ease-out select-none touch-target cursor-pointer ' +
  'disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-forest text-on-forest hover:bg-forest-hover active:bg-forest-hover',
  secondary: 'border border-line-strong bg-surface text-ink hover:bg-mist active:bg-mist',
  ghost: 'bg-transparent text-forest hover:bg-mist active:bg-mist',
  danger: 'bg-crit text-on-forest hover:bg-crit-ink active:bg-crit-ink',
};

const sizes: Record<ButtonSize, string> = {
  md: 'h-control px-3.5',
  sm: 'h-control-compact px-3',
};

export function buttonClasses({
  variant = 'secondary',
  size = 'md',
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}): string {
  return cx(base, variants[variant], sizes[size], className);
}

export type ButtonProps = ComponentPropsWithRef<'button'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Lucide icon shown before the label (18px). */
  icon?: LucideIcon;
  /** Shows a spinner in place of the icon, keeps the label, sets aria-busy and ignores clicks. */
  loading?: boolean;
  /**
   * Disables the action but keeps it focusable, with a tooltip and description saying why
   * ("Only the approver can approve"). Prefer this over `disabled` when users might expect the action.
   */
  disabledReason?: string;
  /** Render the child element (for example a link) with button styles. */
  asChild?: boolean;
};

/** Spec 00 · Button. Sentence case, verb first: "Submit for approval". */
export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  loading = false,
  disabledReason,
  asChild = false,
  className,
  children,
  onClick,
  type,
  ...rest
}: ButtonProps) {
  const reasonId = useId();
  const blocked = loading || !!disabledReason;
  const Comp = asChild ? Slot.Root : 'button';

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (blocked) {
      e.preventDefault();
      return;
    }
    onClick?.(e);
  };

  const describedBy = cx(rest['aria-describedby'], disabledReason && reasonId) || undefined;

  const button = (
    <Comp
      {...(asChild ? {} : { type: type ?? 'button' })}
      {...rest}
      className={buttonClasses({ variant, size, className })}
      aria-disabled={blocked || undefined}
      aria-busy={loading || undefined}
      aria-describedby={describedBy}
      onClick={handleClick}
    >
      {loading ? (
        <LoaderCircle aria-hidden size={18} strokeWidth={1.75} className="animate-spin" />
      ) : Icon ? (
        <Icon aria-hidden size={18} strokeWidth={1.75} />
      ) : null}
      <Slot.Slottable>{children}</Slot.Slottable>
    </Comp>
  );

  if (!disabledReason) return button;
  // The reason sits outside the button so it describes it without becoming part of its name.
  return (
    <>
      <Tooltip content={disabledReason}>{button}</Tooltip>
      <span id={reasonId} hidden>
        {disabledReason}
      </span>
    </>
  );
}

export type IconButtonProps = Omit<ComponentPropsWithRef<'button'>, 'children' | 'aria-label'> & {
  /** Required accessible name, also shown as the tooltip. */
  label: string;
  icon: LucideIcon;
  variant?: Exclude<ButtonVariant, 'danger'>;
  size?: ButtonSize;
  /** Hide the hover/focus tooltip (when the same text is visible next to the button). */
  hideTooltip?: boolean;
};

/** Spec 00 · IconButton. Square 36px (32 small, 44 touch), 18px icon, ghost by default; label is required. */
export function IconButton({
  label,
  icon: Icon,
  variant = 'ghost',
  size = 'md',
  hideTooltip = false,
  className,
  type,
  ...rest
}: IconButtonProps) {
  const square = size === 'md' ? 'w-control shrink-0' : 'w-control-compact shrink-0';
  return (
    <Tooltip content={label} disabled={hideTooltip}>
      <button
        type={type ?? 'button'}
        {...rest}
        aria-label={label}
        className={cx(
          base,
          variant === 'ghost'
            ? 'bg-transparent text-ink hover:bg-mist active:bg-mist'
            : variants[variant],
          size === 'md' ? 'h-control' : 'h-control-compact',
          square,
          className,
        )}
      >
        <Icon aria-hidden size={18} strokeWidth={1.75} />
      </button>
    </Tooltip>
  );
}
