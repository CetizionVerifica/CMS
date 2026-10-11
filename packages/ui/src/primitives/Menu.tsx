import type { LucideIcon } from 'lucide-react';
import { DropdownMenu, Slot } from 'radix-ui';
import type { ComponentPropsWithRef } from 'react';

import { cx } from '../lib/cx';

export const overlayClasses =
  'z-popover rounded-card border border-line bg-surface p-1.5 shadow-overlay outline-none';

/** Spec 00 · DropdownMenu. Arrow keys move, typeahead jumps, Esc closes and returns focus to the trigger. */
export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;
export const MenuGroup = DropdownMenu.Group;
export const MenuRadioGroup = DropdownMenu.RadioGroup;

export function MenuContent({
  className,
  sideOffset = 6,
  align = 'end',
  ...props
}: ComponentPropsWithRef<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        {...props}
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        className={cx(overlayClasses, 'min-w-48', className)}
      />
    </DropdownMenu.Portal>
  );
}

const itemClasses =
  'flex h-control cursor-pointer select-none items-center gap-2 rounded-[7px] px-3 text-body text-ink outline-none ' +
  'data-[highlighted]:bg-mist data-[disabled]:cursor-not-allowed data-[disabled]:text-muted';

export type MenuItemProps = ComponentPropsWithRef<typeof DropdownMenu.Item> & {
  icon?: LucideIcon;
  /** Destructive actions use crit-ink text. They still confirm in a ConfirmDialog. */
  destructive?: boolean;
};

export function MenuItem({
  icon: Icon,
  destructive,
  className,
  children,
  ...props
}: MenuItemProps) {
  return (
    <DropdownMenu.Item
      {...props}
      className={cx(itemClasses, destructive && 'text-crit-ink', className)}
    >
      {Icon ? <Icon aria-hidden size={16} /> : null}
      <Slot.Slottable>{children}</Slot.Slottable>
    </DropdownMenu.Item>
  );
}

export function MenuRadioItem({
  className,
  children,
  ...props
}: ComponentPropsWithRef<typeof DropdownMenu.RadioItem>) {
  return (
    <DropdownMenu.RadioItem {...props} className={cx(itemClasses, 'relative pl-8', className)}>
      <DropdownMenu.ItemIndicator className="absolute left-2.5 size-2 rounded-pill bg-forest" />
      {children}
    </DropdownMenu.RadioItem>
  );
}

export function MenuLabel({
  className,
  ...props
}: ComponentPropsWithRef<typeof DropdownMenu.Label>) {
  return (
    <DropdownMenu.Label
      {...props}
      className={cx('px-3 py-1.5 text-label uppercase text-muted', className)}
    />
  );
}

export function MenuSeparator({
  className,
  ...props
}: ComponentPropsWithRef<typeof DropdownMenu.Separator>) {
  return <DropdownMenu.Separator {...props} className={cx('my-1.5 h-px bg-line', className)} />;
}
