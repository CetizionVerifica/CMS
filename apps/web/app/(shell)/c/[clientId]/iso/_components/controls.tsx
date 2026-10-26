'use client';
// Controls every ISO screen uses: a step button that confirms (with a reason when the step needs one), a person picker
// and the line that says what went wrong.
import { Button, ConfirmDialog, Drawer, Select, toast, type ButtonVariant } from '@canopy/ui';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';

import type { Outcome } from '../_lib/outcome';
import type { PersonOption } from '../_lib/people';

export function FormAlert({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="text-body text-crit-ink">
      {message}
    </p>
  ) : null;
}

export type StepButtonProps = {
  /** The button: "Approve", "Send back". */
  label: string;
  /** The dialog's question: "Approve revision B?" */
  title: string;
  body?: string;
  /** Asks for a reason (stored on the record or its audit event) before the step runs; `optional` for a comment. */
  reason?: { label: string; helper?: string; optional?: boolean };
  variant?: ButtonVariant;
  tone?: 'primary' | 'danger';
  /** What the toast says once the step is done. */
  done: string;
  run: (reason?: string) => Promise<Outcome<unknown>>;
};

/** One machine step, offered only when the record's `allowedActions` lists it (the caller decides that). */
export function StepButton({
  label,
  title,
  body,
  reason,
  variant = 'secondary',
  tone = 'primary',
  done,
  run,
}: StepButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button variant={variant} size="sm" onClick={() => setOpen(true)}>
        {label}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setError(null);
        }}
        title={title}
        body={error ?? body}
        confirmLabel={label}
        tone={tone}
        reason={
          reason
            ? {
                label: reason.label,
                helper: reason.helper,
                required: !reason.optional,
                maxLength: 2000,
                multiline: true,
              }
            : undefined
        }
        onConfirm={async (text) => {
          const result = await run(text?.trim());
          if (!result.ok) {
            setError(result.message);
            throw new Error(result.message);
          }
          toast({ tone: 'success', message: done });
          router.refresh();
        }}
      />
    </>
  );
}

/** A person from the client's people; `none` adds an empty choice. */
export function PersonSelect({
  label,
  people,
  value,
  onChange,
  none,
  helper,
  error,
}: {
  label: string;
  people: readonly PersonOption[];
  value: string | null;
  onChange: (id: string | null) => void;
  none?: string;
  helper?: string;
  error?: string;
}) {
  const NONE = '__none__';
  const options = [
    ...(none ? [{ value: NONE, label: none }] : []),
    ...people.map((p) => ({ value: p.id, label: p.name })),
  ];
  // A person outside the list (not a member any more) still shows by name until changed.
  if (value && !people.some((p) => p.id === value))
    options.push({ value, label: 'Someone not listed' });
  return (
    <Select
      label={label}
      helper={helper}
      error={error}
      options={options}
      value={value ?? (none ? NONE : undefined)}
      onValueChange={(v) => onChange(v === NONE ? null : v)}
    />
  );
}

/** Runs a save: shows it pending, keeps the API's words on failure, and on success says so and reloads the page. */
export function useSave() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (run: () => Promise<Outcome<unknown>>, done: string): Promise<boolean> => {
    setPending(true);
    setError(null);
    const result = await run();
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return false;
    }
    toast({ tone: 'success', message: done });
    router.refresh();
    return true;
  };
  return { pending, error, setError, save };
}

/** A form in a drawer: fields in the body, Cancel and the save button in the footer. */
export function FormDrawer({
  open,
  onOpenChange,
  title,
  submitLabel,
  pending,
  error,
  disabledReason,
  onSubmit,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  submitLabel: string;
  pending: boolean;
  error: string | null;
  disabledReason?: string;
  onSubmit: () => void;
  children: ReactNode;
}) {
  const formId = `form-${title.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="md"
      backLabel="Back"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            loading={pending}
            disabledReason={disabledReason}
          >
            {submitLabel}
          </Button>
        </div>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (!disabledReason) onSubmit();
        }}
      >
        {children}
        <FormAlert message={error} />
      </form>
    </Drawer>
  );
}
