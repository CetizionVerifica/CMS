// @canopy/ui: Canopy design system. Styles: import '@canopy/ui/styles.css' after Tailwind (see README.md).

export * as tokens from './tokens';
export { contrastRatio } from './contrast';
export { cx } from './lib/cx';
export { useMediaQuery } from './lib/useMediaQuery';

// 00 · Primitives
export { Button, IconButton, buttonClasses } from './primitives/Button';
export type { ButtonProps, ButtonSize, ButtonVariant, IconButtonProps } from './primitives/Button';
export { Field, Input, Textarea } from './primitives/Field';
export type { FieldProps, InputProps, TextareaProps } from './primitives/Field';
export { Select } from './primitives/Select';
export type { SelectOption, SelectProps } from './primitives/Select';
export { Combobox } from './primitives/Combobox';
export type { ComboboxOption, ComboboxProps } from './primitives/Combobox';
export { Checkbox, RadioGroup, Switch } from './primitives/Checkbox';
export type { CheckboxProps, RadioGroupProps, SwitchProps } from './primitives/Checkbox';
export { Tabs, TabsContent, TabsList, TabsTrigger } from './primitives/Tabs';
export {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from './primitives/Menu';
export type { MenuItemProps } from './primitives/Menu';
export {
  Popover,
  PopoverAnchor,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from './primitives/Popover';
export { Tooltip, TooltipProvider } from './primitives/Tooltip';
export type { TooltipProps } from './primitives/Tooltip';
export { Avatar, AvatarGroup, initials } from './primitives/Avatar';
export type { AvatarGroupProps, AvatarProps, AvatarSize } from './primitives/Avatar';
export { Badge, formatCount } from './primitives/Badge';
export type { BadgeProps } from './primitives/Badge';
export { LoadingRegion, Skeleton } from './primitives/Skeleton';
export type { LoadingRegionProps } from './primitives/Skeleton';
export { Link, linkClasses } from './primitives/Link';
export type { LinkProps } from './primitives/Link';

// 01 · AppShell
export { AppShell } from './components/AppShell';
export type {
  AppShellLayout,
  AppShellProps,
  LinkRenderer,
  NavGroup,
  NavItem,
  PrimaryAction,
  UserMenuItem,
  UserMenuProps,
} from './components/AppShell';
