import { Tooltip as RadixTooltip } from 'radix-ui';
import { createContext, useContext, type ReactNode } from 'react';

const InProvider = createContext(false);

/**
 * One provider for a region (AppShell mounts it) so moving between neighbouring tooltips skips the delay.
 * A Tooltip outside any provider mounts its own.
 */
export function TooltipProvider({
  children,
  delay = 400,
}: {
  children: ReactNode;
  delay?: number;
}) {
  return (
    <RadixTooltip.Provider delayDuration={delay}>
      <InProvider.Provider value>{children}</InProvider.Provider>
    </RadixTooltip.Provider>
  );
}

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
  const provided = useContext(InProvider);
  if (disabled) return <>{children}</>;
  const tooltip = (
    <RadixTooltip.Root delayDuration={delay}>
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
  );
  return provided ? (
    tooltip
  ) : (
    <RadixTooltip.Provider delayDuration={delay}>{tooltip}</RadixTooltip.Provider>
  );
}
