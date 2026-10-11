import { Popover as RadixPopover } from 'radix-ui';
import type { ComponentPropsWithRef } from 'react';

import { cx } from '../lib/cx';
import { overlayClasses } from './Menu';

/** Spec 00 · Popover. Focus moves into the content and returns to the trigger on close. */
export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverAnchor = RadixPopover.Anchor;
export const PopoverClose = RadixPopover.Close;

export function PopoverContent({
  className,
  sideOffset = 6,
  align = 'start',
  ...props
}: ComponentPropsWithRef<typeof RadixPopover.Content>) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        {...props}
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        className={cx(overlayClasses, className)}
      />
    </RadixPopover.Portal>
  );
}
