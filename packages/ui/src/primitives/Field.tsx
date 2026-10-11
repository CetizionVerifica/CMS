import { AlertCircle } from 'lucide-react';
import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';

import { cx } from '../lib/cx';

export type FieldControlProps = {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
};

export type FieldProps = {
  label: string;
  /** Keep the label for screen readers only (a visible heading or column already names the field). */
  hideLabel?: boolean;
  helper?: string;
  error?: string;
  /** Use a specific id for the control; defaults to a generated one. */
  id?: string;
  className?: string;
  /** Renders the control with the id and ARIA wiring for label, helper and error. */
  children: (control: FieldControlProps) => ReactNode;
};

/** Spec 00 · label above (meta, ink, 600), helper below (meta, muted), error below (meta, crit-ink, AlertCircle). */
export function Field({ label, hideLabel, helper, error, id, className, children }: FieldProps) {
  const generated = useId();
  const controlId = id ?? generated;
  const helperId = `${controlId}-helper`;
  const errorId = `${controlId}-error`;
  const describedBy = cx(helper && helperId, error && errorId) || undefined;

  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={controlId} className={hideLabel ? 'sr-only' : 'text-meta text-ink'}>
        {label}
      </label>
      {children({
        id: controlId,
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        ...(error ? { 'aria-invalid': true as const } : {}),
      })}
      {helper ? (
        <p id={helperId} className="text-meta text-muted">
          {helper}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="flex items-center gap-1 text-meta text-crit-ink">
          <AlertCircle aria-hidden size={16} className="shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}

export const controlClasses = (invalid?: boolean) =>
  cx(
    'w-full rounded-control border bg-surface px-3 text-body text-ink placeholder:text-muted touch-target',
    'transition-colors duration-fast ease-out',
    'disabled:cursor-not-allowed disabled:bg-mist disabled:text-muted',
    invalid ? 'border-crit' : 'border-line-strong',
  );

type TextControlProps = {
  label: string;
  hideLabel?: boolean;
  helper?: string;
  error?: string;
  /** Classes for the outer field wrapper. */
  className?: string;
};

/** The caller's own aria-describedby ids, then the field's helper and error ids. */
const mergeIds = (...ids: (string | undefined)[]) => ids.filter(Boolean).join(' ') || undefined;

export type InputProps = Omit<ComponentPropsWithRef<'input'>, 'className' | 'size'> &
  TextControlProps;

/** Spec 00 · Input. 36px, 9px radius, line-strong border; error border crit with aria-invalid. */
export function Input({ label, hideLabel, helper, error, className, id, ...rest }: InputProps) {
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
        <input
          {...rest}
          {...control}
          aria-describedby={mergeIds(rest['aria-describedby'], control['aria-describedby'])}
          className={cx(controlClasses(!!error), 'h-control')}
        />
      )}
    </Field>
  );
}

export type TextareaProps = Omit<ComponentPropsWithRef<'textarea'>, 'className'> & TextControlProps;

/** Spec 00 · Textarea. Same field anatomy as Input; grows with `rows`. */
export function Textarea({
  label,
  hideLabel,
  helper,
  error,
  className,
  id,
  rows = 4,
  ...rest
}: TextareaProps) {
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
        <textarea
          {...rest}
          {...control}
          aria-describedby={mergeIds(rest['aria-describedby'], control['aria-describedby'])}
          rows={rows}
          className={cx(controlClasses(!!error), 'py-2')}
        />
      )}
    </Field>
  );
}
