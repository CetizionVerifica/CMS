import { ArrowLeft, ChevronDown, ChevronUp, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { cx } from '../lib/cx';
import { useMediaQuery } from '../lib/useMediaQuery';
import { useReturnFocus } from '../lib/useReturnFocus';
import { IconButton } from '../primitives/Button';
import { Skeleton } from '../primitives/Skeleton';
import { ConfirmDialog } from './ConfirmDialog';
import { EmptyState } from './EmptyState';

export type DrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Above the title, e.g. the instance ID with a copy button. */
  eyebrow?: ReactNode;
  /** Status, criticality and due date; it also describes the dialog. */
  meta?: ReactNode;
  /** Previous and next record in the current table order (also J/K and Alt+ArrowUp/Down). */
  onPrev?: () => void;
  onNext?: () => void;
  /** Noun for the prev/next buttons: "instance" gives "Previous instance". */
  itemNoun?: string;
  /** Sticky footer: secondary actions left, one primary action right. */
  footer?: ReactNode;
  /** Ctrl/Cmd+Enter in a text box runs the primary action (only pass non-destructive actions). */
  onSubmitShortcut?: () => void;
  /** Unsaved input: closing asks "Discard your comment?" first. */
  dirty?: boolean;
  dirtyPrompt?: { title: string; body?: string; confirmLabel?: string };
  loading?: boolean;
  error?: { message: string; retry: () => void; errorId?: string };
  /** The record does not exist or the user cannot see it. */
  unavailable?: boolean;
  /** Under 640px the drawer is full screen and close becomes a back arrow with this label. */
  backLabel?: string;
  size?: 'lg' | 'md';
  children?: ReactNode;
};

const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

/**
 * Spec 11 · Drawer. A modal Radix Dialog from the right with a sticky header and footer. On open, focus goes to the
 * title so screen readers start with context; on close it returns to whatever opened it.
 */
export function Drawer({
  open,
  onOpenChange,
  title,
  eyebrow,
  meta,
  onPrev,
  onNext,
  itemNoun = 'item',
  footer,
  onSubmitShortcut,
  dirty = false,
  dirtyPrompt = { title: 'Discard your comment?', body: "What you've typed will be lost." },
  loading = false,
  error,
  unavailable = false,
  backLabel = 'Back',
  size = 'lg',
  children,
}: DrawerProps) {
  const sm = useMediaQuery('(min-width: 640px)', true);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const metaId = useId();
  const [confirmClose, setConfirmClose] = useState(false);
  const returnFocus = useReturnFocus(open);

  const requestClose = () => (dirty ? setConfirmClose(true) : onOpenChange(false));

  // Prev/next changes the record: move focus back to the new title so it is announced.
  useEffect(() => {
    if (open) titleRef.current?.focus();
  }, [open, title]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && typing(e.target) && onSubmitShortcut) {
      e.preventDefault();
      onSubmitShortcut();
      return;
    }
    if (typing(e.target) || e.ctrlKey || e.metaKey) return;
    const next = e.key === 'j' || (e.altKey && e.key === 'ArrowDown');
    const prev = e.key === 'k' || (e.altKey && e.key === 'ArrowUp');
    if (next && onNext) {
      e.preventDefault();
      onNext();
    } else if (prev && onPrev) {
      e.preventDefault();
      onPrev();
    }
  };

  const showBody = !loading && !error && !unavailable;

  return (
    <>
      <Dialog.Root open={open} onOpenChange={(o) => (o ? onOpenChange(true) : requestClose())}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-drawer bg-scrim" />
          <Dialog.Content
            aria-describedby={meta && showBody ? metaId : undefined}
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              titleRef.current?.focus();
            }}
            onCloseAutoFocus={returnFocus}
            onKeyDown={onKeyDown}
            className={cx(
              'fixed inset-y-0 right-0 z-drawer flex w-full flex-col bg-surface shadow-overlay outline-none',
              size === 'lg' ? 'sm:max-w-drawer-lg' : 'sm:max-w-drawer-md',
              'animate-[canopy-drawer-in_var(--dur-slow)_var(--ease-out)] motion-reduce:animate-[canopy-fade-in_var(--dur-base)_linear]',
            )}
          >
            <header className="flex items-start gap-3 border-b border-line px-4 py-4 sm:px-5.5">
              {!sm ? (
                <IconButton
                  label={backLabel}
                  icon={ArrowLeft}
                  variant="ghost"
                  hideTooltip
                  onClick={requestClose}
                  className="-ml-2"
                />
              ) : null}
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                {eyebrow ? <div className="text-meta text-muted">{eyebrow}</div> : null}
                {loading ? <Skeleton className="h-5 w-3/4" /> : null}
                <Dialog.Title
                  ref={titleRef}
                  tabIndex={-1}
                  className={cx(
                    'line-clamp-3 text-section text-ink outline-none',
                    loading && 'sr-only',
                  )}
                >
                  {title}
                </Dialog.Title>
                {meta && showBody ? (
                  <div
                    id={metaId}
                    className="flex flex-wrap items-center gap-2 text-meta text-muted"
                  >
                    {meta}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {onPrev ? (
                  <IconButton
                    label={`Previous ${itemNoun}`}
                    icon={ChevronUp}
                    variant="ghost"
                    onClick={onPrev}
                  />
                ) : null}
                {onNext ? (
                  <IconButton
                    label={`Next ${itemNoun}`}
                    icon={ChevronDown}
                    variant="ghost"
                    onClick={onNext}
                  />
                ) : null}
                {sm ? (
                  <IconButton label="Close" icon={X} variant="ghost" onClick={requestClose} />
                ) : null}
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5.5 sm:px-5.5">
              {loading ? (
                <div aria-busy="true" className="flex flex-col gap-5.5">
                  <span className="sr-only">Loading</span>
                  {[0, 1, 2].map((n) => (
                    <div key={n} className="flex flex-col gap-2">
                      <Skeleton className="h-4 w-1/3" />
                      <Skeleton className="h-3.5 w-full" />
                      <Skeleton className="h-3.5 w-5/6" />
                    </div>
                  ))}
                </div>
              ) : error ? (
                <EmptyState
                  variant="error"
                  title="Couldn't load this"
                  body={error.message}
                  errorId={error.errorId}
                  action={{ label: 'Retry', onClick: error.retry }}
                />
              ) : unavailable ? (
                <EmptyState
                  variant="no-permission"
                  title={`This ${itemNoun} isn't available to you`}
                  body="It may have been removed, or you may not have access to it."
                />
              ) : (
                <div className="flex flex-col gap-5.5">{children}</div>
              )}
            </div>

            {footer && showBody ? (
              <footer
                className={cx(
                  'sticky bottom-0 z-sticky flex gap-2 border-t border-line bg-surface px-4 py-3 sm:px-5.5',
                  'flex-col-reverse sm:flex-row sm:items-center sm:justify-between [&_button]:max-sm:w-full',
                )}
              >
                {footer}
              </footer>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <ConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title={dirtyPrompt.title}
        body={dirtyPrompt.body}
        confirmLabel={dirtyPrompt.confirmLabel ?? 'Discard'}
        tone="danger"
        onConfirm={() => onOpenChange(false)}
      />
    </>
  );
}

/** A drawer body section with a card heading. */
export function DrawerSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-card text-ink">{title}</h3>
      {children}
    </section>
  );
}
