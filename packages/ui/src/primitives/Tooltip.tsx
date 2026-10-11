import { Tooltip as RadixTooltip } from 'radix-ui';
import type { ReactNode } from 'react';

export type TooltipProps = {
  /** Text shown in the tooltip. It must never hold information that keyboard users cannot reach another way. */
  content: ReactNode;
  /** The trigger: a single focusable element. */
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** Delay before showing, in ms. Spec default 400ms. */
  delay?: number;
  /** Skip the tooltip entirely (for example when a label is already visible). */
  disabled?: boolean;
};

/** Spec 00 · Tooltip. Ink background, white meta text, 6px radius, max 280px. Opens on hover and focus. */
export function Tooltip({ content, children, side = 'top', delay = 400, disabled }: TooltipProps) {
  if (disabled) return <>{children}</>;
  return (
    <RadixTooltip.Provider delayDuration={delay}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            side={side}
            sideOffset={6}
            collisionPadding={8}
            className="z-popover max-w-[280px] rounded-tag bg-ink px-2 py-1 text-meta text-surface shadow-overlay"
          >
            {content}
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
