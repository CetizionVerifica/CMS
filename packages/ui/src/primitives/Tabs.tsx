import { Tabs as RadixTabs } from 'radix-ui';
import type { ComponentPropsWithRef } from 'react';

import { cx } from '../lib/cx';

/** Spec 00 · Tabs. Radix Tabs: arrow keys move, Home/End jump, the list is one tab stop. */
export function Tabs({ className, ...props }: ComponentPropsWithRef<typeof RadixTabs.Root>) {
  return <RadixTabs.Root {...props} className={cx('flex flex-col', className)} />;
}

export function TabsList({ className, ...props }: ComponentPropsWithRef<typeof RadixTabs.List>) {
  return (
    <RadixTabs.List
      {...props}
      className={cx(
        'flex gap-1 overflow-x-auto border-b border-line [scrollbar-width:none]',
        className,
      )}
    />
  );
}

export function TabsTrigger({
  className,
  ...props
}: ComponentPropsWithRef<typeof RadixTabs.Trigger>) {
  return (
    <RadixTabs.Trigger
      {...props}
      className={cx(
        'relative h-control shrink-0 cursor-pointer whitespace-nowrap px-3 text-body font-semibold text-muted',
        'hover:text-ink data-[state=active]:font-bold data-[state=active]:text-ink',
        'after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-transparent data-[state=active]:after:bg-forest',
        'disabled:cursor-not-allowed disabled:opacity-50 touch-target',
        className,
      )}
    />
  );
}

export function TabsContent({
  className,
  ...props
}: ComponentPropsWithRef<typeof RadixTabs.Content>) {
  return <RadixTabs.Content {...props} className={cx('pt-4', className)} />;
}
