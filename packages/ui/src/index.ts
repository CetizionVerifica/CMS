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
export { DateInput } from './primitives/DateInput';
export type { DateInputProps } from './primitives/DateInput';

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

// 02-03 · Client and period context
export { ClientSwitcher } from './components/ClientSwitcher';
export type { ClientSummary, ClientSwitcherProps } from './components/ClientSwitcher';
export { PeriodPicker } from './components/PeriodPicker';
export type { Period, PeriodPickerProps, Quarter } from './components/PeriodPicker';
export { fyLabel, periodLabel, periodName } from './lib/period';

// 04-08 · Metrics and status language
export { KpiCard } from './components/KpiCard';
export type { KpiCardProps } from './components/KpiCard';
export { ScoreRing } from './components/ScoreRing';
export type { ScoreRingProps } from './components/ScoreRing';
export { ProgressBar } from './components/ProgressBar';
export type { ProgressBarProps, Segment, SegmentKey } from './components/ProgressBar';
export { DERIVED_STATUSES, StatusPill, statusLabel } from './components/StatusPill';
export type { DerivedStatus, StatusPillProps } from './components/StatusPill';
export { CRITICALITY_LABEL, CRITICALITY_ORDER, CriticalityTag } from './components/CriticalityTag';
export type { Criticality, CriticalityTagProps } from './components/CriticalityTag';
export { formatDate, formatNumber, formatPercent } from './lib/format';
export { defaultLink } from './lib/link';

// 09 · DataTable
export { DataTable } from './components/data-table/DataTable';
export type { BulkAction, DataTableProps, Density } from './components/data-table/DataTable';
export type {
  ColumnType,
  PersonValue,
  StatusValue,
  TitleValue,
} from './components/data-table/cells';
export type { TableContext } from './components/data-table/context';

// 11, 18 · Drawer and ConfirmDialog
export { Drawer, DrawerSection } from './components/Drawer';
export type { DrawerProps } from './components/Drawer';
export { ConfirmDialog } from './components/ConfirmDialog';
export type { ConfirmDialogProps } from './components/ConfirmDialog';

// 14, 17 · Feedback
export { EmptyState } from './components/EmptyState';
export type { EmptyStateProps, EmptyStateVariant } from './components/EmptyState';
export { dismissToast, toast, Toaster } from './components/Toast';
export type { ToastOptions, ToastTone } from './components/Toast';
