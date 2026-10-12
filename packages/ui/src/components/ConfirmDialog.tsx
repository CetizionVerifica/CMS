import { AlertDialog } from 'radix-ui';
import { useEffect, useRef, useState } from 'react';

import { cx } from '../lib/cx';
import { useReturnFocus } from '../lib/useReturnFocus';
import { Button } from '../primitives/Button';
import { Input, Textarea } from '../primitives/Field';

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The action as a question: "Send back to Priya Rane?" */
  title: string;
  /** The consequence in one sentence. */
  body?: string;
  /** Repeats the verb: "Send back", never "OK" or "Yes". */
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  /**
   * A text the user types: a reason (multi-line, the default) or a short name (`multiline: false`, Enter confirms).
   * `initialValue` pre-fills it, e.g. the current name when renaming.
   */
  reason?: {
    label: string;
    required: boolean;
    minLength?: number;
    maxLength?: number;
    helper?: string;
    multiline?: boolean;
    initialValue?: string;
  };
  /**
   * Where focus goes when the dialog closes, resolved at that moment. Use it when the action removes the element that
   * opened the dialog (a file row's Remove button): return the next row's control, or a stable fallback.
   */
  returnFocusTo?: () => HTMLElement | null | undefined;
  /** The dialog shows a loading button until this settles; it closes on success and stays open on failure. */
  onConfirm: (reason?: string) => Promise<void> | void;
};

/** Spec 18 · ConfirmDialog. Radix AlertDialog that confirms a consequential action, with an optional reason. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  tone = 'primary',
  reason,
  onConfirm,
  returnFocusTo,
}: ConfirmDialogProps) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useReturnFocus(open);
  // Read only when the dialog opens, so a new value while open never overwrites what the user typed.
  const initialValue = useRef(reason?.initialValue);
  initialValue.current = reason?.initialValue;

  // Start fresh each time it opens.
  useEffect(() => {
    if (open) {
      setText(initialValue.current ?? '');
      setError(null);
      setFailed(false);
      setPending(false);
    }
  }, [open]);

  const min = reason?.minLength ?? (reason?.required ? 1 : 0);

  const confirm = async () => {
    const trimmed = text.trim();
    if (reason && trimmed.length < min) {
      setError(
        min > 1
          ? `Enter a ${reason.label.replace(/ \(required\)$/i, '').toLowerCase()} of at least ${min} characters.`
          : `Enter a ${reason.label.replace(/ \(required\)$/i, '').toLowerCase()}.`,
      );
      reasonRef.current?.focus();
      return;
    }
    setPending(true);
    setFailed(false);
    try {
      await onConfirm(reason ? trimmed || undefined : undefined);
      onOpenChange(false);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-dialog bg-scrim" />
        <AlertDialog.Content
          onCloseAutoFocus={(e) => {
            const target = returnFocusTo?.();
            if (target && target.isConnected) {
              e.preventDefault();
              target.focus();
            } else returnFocus(e);
          }}
          onOpenAutoFocus={(e) => {
            // The text field first; otherwise Confirm for a primary action and Cancel (Radix's default) for danger.
            if (reason) {
              e.preventDefault();
              reasonRef.current?.focus();
            } else if (tone === 'primary') {
              e.preventDefault();
              confirmRef.current?.focus();
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !pending) {
              e.preventDefault();
              void confirm();
            }
          }}
          className={cx(
            'fixed left-1/2 top-1/2 z-dialog flex w-[calc(100vw-32px)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 flex-col gap-3',
            'rounded-card bg-surface p-5.5 shadow-overlay',
          )}
        >
          <AlertDialog.Title className="text-section text-ink">{title}</AlertDialog.Title>
          {body ? (
            <AlertDialog.Description className="text-body text-muted">
              {body}
            </AlertDialog.Description>
          ) : (
            <AlertDialog.Description className="sr-only">{title}</AlertDialog.Description>
          )}
          {reason && reason.multiline === false ? (
            <Input
              ref={reasonRef}
              label={reason.label}
              helper={reason.helper}
              error={error ?? undefined}
              required={reason.required}
              maxLength={reason.maxLength}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && !pending) {
                  e.preventDefault();
                  void confirm();
                }
              }}
            />
          ) : reason ? (
            <Textarea
              ref={reasonRef}
              label={reason.label}
              helper={reason.helper}
              error={error ?? undefined}
              rows={3}
              required={reason.required}
              maxLength={reason.maxLength}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                if (error) setError(null);
              }}
            />
          ) : null}
          {failed ? (
            <p role="alert" className="text-meta text-crit-ink">
              That didn't work. Try again.
            </p>
          ) : null}
          <div className="mt-1 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AlertDialog.Cancel asChild>
              <Button disabled={pending}>Cancel</Button>
            </AlertDialog.Cancel>
            <Button
              ref={confirmRef}
              variant={tone}
              loading={pending}
              onClick={() => void confirm()}
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
