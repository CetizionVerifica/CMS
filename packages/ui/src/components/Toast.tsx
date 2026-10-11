import { AlertCircle, AlertTriangle, CheckCircle2, Info, X, type LucideIcon } from 'lucide-react';
import { Toast as RadixToast } from 'radix-ui';
import { useSyncExternalStore } from 'react';

import { cx } from '../lib/cx';

export type ToastTone = 'success' | 'info' | 'warn' | 'error';

export type ToastOptions = {
  tone: ToastTone;
  message: string;
  action?: { label: string; onClick: () => void };
  /** Milliseconds; defaults by tone. Errors stay until dismissed. */
  duration?: number;
};

type Entry = ToastOptions & { id: number };

const DURATION: Record<ToastTone, number> = {
  success: 5000,
  info: 3000,
  warn: 8000,
  error: Infinity,
};
/** Undo must be reachable before the toast goes. */
const ACTION_MIN = 6000;
const MAX_VISIBLE = 3;

let entries: Entry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(next: Entry[]) {
  entries = next;
  listeners.forEach((l) => l());
}

/**
 * Spec 17 · shows a toast in the app's Toaster. Never the only path to an outcome: the page state must show it too.
 * Returns an id for `dismissToast`.
 */
export function toast(options: ToastOptions): number {
  const id = nextId++;
  emit([...entries, { ...options, id }]);
  return id;
}

export function dismissToast(id: number): void {
  emit(entries.filter((e) => e.id !== id));
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => entries;

export function durationFor({ tone, action, duration }: ToastOptions): number {
  const d = duration ?? DURATION[tone];
  return action ? Math.max(d, ACTION_MIN) : d;
}

const tones: Record<ToastTone, { bar: string; icon: LucideIcon }> = {
  success: { bar: 'before:bg-ok', icon: CheckCircle2 },
  info: { bar: 'before:bg-muted', icon: Info },
  warn: { bar: 'before:bg-warn', icon: AlertTriangle },
  error: { bar: 'before:bg-crit', icon: AlertCircle },
};

/**
 * Spec 17 · Toaster. Render once near the root of the app. Bottom-right from 640px, bottom-centre below that.
 * F8 moves focus to the toasts; timers pause on hover and focus.
 */
export function Toaster() {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot);
  // The newest three are visible; older ones wait until those close.
  const visible = all.slice(-MAX_VISIBLE);

  return (
    <RadixToast.Provider swipeDirection="right" label="Notification">
      {visible.map((e) => {
        const { bar, icon: Icon } = tones[e.tone];
        const duration = durationFor(e);
        return (
          <RadixToast.Root
            key={e.id}
            open
            onOpenChange={(open) => {
              if (!open) dismissToast(e.id);
            }}
            duration={Number.isFinite(duration) ? duration : 2_147_483_647}
            // Errors interrupt (assertive); everything else is polite.
            type={e.tone === 'error' ? 'foreground' : 'background'}
            className={cx(
              'relative flex items-start gap-2.5 overflow-hidden rounded-card bg-ink py-3 pl-3.5 pr-2 text-body text-on-forest shadow-overlay',
              "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-['']",
              'data-[state=open]:animate-[canopy-toast-in_var(--dur-base)_var(--ease-out)] motion-reduce:animate-none',
              bar,
            )}
          >
            <Icon aria-hidden size={18} className="mt-0.5 shrink-0" />
            <RadixToast.Description className="min-w-0 flex-1 py-0.5">
              {e.message}
            </RadixToast.Description>
            {e.action ? (
              <RadixToast.Action
                altText={e.action.label}
                onClick={e.action.onClick}
                className="shrink-0 rounded-control px-2 py-0.5 text-body-strong text-on-forest-muted underline underline-offset-2 hover:text-on-forest touch-target"
              >
                {e.action.label}
              </RadixToast.Action>
            ) : null}
            <RadixToast.Close
              aria-label="Dismiss"
              className="-my-1 inline-flex size-8 shrink-0 items-center justify-center rounded-control text-on-forest hover:bg-on-forest-hover touch-target"
            >
              <X aria-hidden size={16} />
            </RadixToast.Close>
          </RadixToast.Root>
        );
      })}
      <RadixToast.Viewport
        className={cx(
          'fixed bottom-4 left-4 right-4 z-toast flex flex-col gap-2 outline-none',
          'sm:bottom-5.5 sm:left-auto sm:right-5.5 sm:w-[360px]',
        )}
      />
    </RadixToast.Provider>
  );
}

/** Test helper: clear every toast between tests. */
export function resetToasts(): void {
  emit([]);
}
