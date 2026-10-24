'use client';
// A drawer holding one form: Cancel and the action in the footer, the API's error above the fields. It stays open
// when the call fails, so nothing typed is lost.
import { Button, Drawer } from '@canopy/ui';
import { useId, useState, type FormEvent, type ReactNode } from 'react';

import { errorMessage, fieldErrors } from '../api';
import { FormError } from './parts';

export function FormDrawer({
  open,
  onOpenChange,
  title,
  submitLabel,
  tone = 'primary',
  onSubmit,
  onFieldErrors,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  submitLabel: string;
  tone?: 'primary' | 'danger';
  /**
   * Throws to keep the drawer open. A thrown string is shown as is: a check before the call, which may set its own
   * field errors first.
   */
  onSubmit: () => Promise<void>;
  onFieldErrors?: (fields: Record<string, string>) => void;
  children: ReactNode;
}) {
  const formId = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    onFieldErrors?.({});
    try {
      await onSubmit();
      onOpenChange(false);
    } catch (e) {
      if (typeof e === 'string') {
        setError(e);
      } else {
        setError(errorMessage(e));
        onFieldErrors?.(fieldErrors(e));
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
      title={title}
      size="md"
      backLabel="Back to the account"
      footer={
        <>
          <Button variant="secondary" type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            loading={pending}
            variant={tone === 'danger' ? 'danger' : 'primary'}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-3">
        <FormError message={error} />
        {children}
      </form>
    </Drawer>
  );
}
