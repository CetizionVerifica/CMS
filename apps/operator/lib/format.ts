// Display only: dates, money, limits and the words for statuses and operator actions. The console runs in India, so
// instants show in Asia/Kolkata (ADR M15-0003 decision 8). Rules about accounts stay in the API.
import type {
  AccountKind,
  AccountStatus,
  OperatorAuditAction,
  SupportGrantStatus,
} from '@canopy/contracts';
import { formatDate, formatNumber } from '@canopy/ui';

export { CONSOLE_NAME } from './brand';
export const CONSOLE_TIME_ZONE = 'Asia/Kolkata';

export { formatDate };

/** "24 Oct 2026, 15:05 IST". */
export function formatInstant(instant: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: CONSOLE_TIME_ZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')} ${get('month')} ${get('year')}, ${get('hour')}:${get('minute')} IST`;
}

/** Paise as rupees with Indian grouping: 1234500 → "₹12,345". Paise show only when there are any. */
export function formatRupees(paise: number): string {
  const rupees = paise / 100;
  return `₹${new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(rupees)}`;
}

/** Rupees typed in a form ("12,345.50") as paise, or null when it is not an amount. */
export function paiseFrom(text: string): number | null {
  const clean = text.replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : Math.round(value * 10) / 10} ${units[unit]}`;
}

/** "3 of 5", "3 of unlimited". Storage reads as bytes. */
export function usageOf(used: number, limit: number | null, bytes = false): string {
  const show = (n: number) => (bytes ? formatBytes(n) : formatNumber(n));
  return `${show(used)} of ${limit === null ? 'unlimited' : show(limit)}`;
}

/** Whether a count has reached its limit (null is unlimited). */
export function atLimit(used: number, limit: number | null): boolean {
  return limit !== null && used >= limit;
}

export type Tone = 'neutral' | 'ok' | 'warn' | 'crit';

export const STATUS: Record<AccountStatus, { label: string; tone: Tone }> = {
  PROVISIONING: { label: 'Waiting for owner', tone: 'neutral' },
  TRIAL: { label: 'Trial', tone: 'warn' },
  ACTIVE: { label: 'Active', tone: 'ok' },
  SUSPENDED: { label: 'Suspended', tone: 'crit' },
  PENDING_DELETION: { label: 'Deletion pending', tone: 'crit' },
  DELETED: { label: 'Deleted', tone: 'neutral' },
};

export const KIND: Record<AccountKind, string> = {
  ENTERPRISE: 'Company',
  CONSULTANCY: 'Consultancy',
};

export const GRANT_STATUS: Record<SupportGrantStatus, string> = {
  ACTIVE: 'Active',
  EXPIRED: 'Ended',
  REVOKED: 'Revoked',
};

export const ACTION: Record<OperatorAuditAction, string> = {
  OPERATOR_LOGIN: 'Signed in',
  ACCOUNT_CREATE: 'Created account',
  OWNER_INVITE_SEND: 'Sent owner invite',
  ACCOUNT_ACTIVATE: 'Owner accepted',
  ACCOUNT_SUSPEND: 'Suspended account',
  ACCOUNT_RESUME: 'Resumed account',
  TRIAL_CONVERT: 'Converted trial',
  TRIAL_EXTEND: 'Moved trial end',
  ACCOUNT_UPDATE: 'Changed account',
  PLAN_CHANGE: 'Changed plan',
  OVERRIDE_CHANGE: 'Changed limits',
  SUBSCRIPTION_RECORD: 'Recorded subscription',
  ACCOUNT_DELETE_REQUEST: 'Requested deletion',
  ACCOUNT_DELETE_CANCEL: 'Cancelled deletion',
  ACCOUNT_PURGE: 'Purged account',
  SUPPORT_ACCESS_START: 'Opened support session',
  SUPPORT_ACCESS_END: 'Ended support session',
};

export const toneClasses: Record<Tone, string> = {
  neutral: 'bg-neutral-soft text-muted',
  ok: 'bg-ok-soft text-ok-ink',
  warn: 'bg-warn-soft text-warn-ink',
  crit: 'bg-crit-soft text-crit-ink',
};

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function monthName(month: number): string {
  return MONTHS[month - 1] ?? String(month);
}

export const MONTH_OPTIONS = MONTHS.map((label, i) => ({ value: String(i + 1), label }));

/** Today in the console's time zone, as a calendar date. */
export function todayInIndia(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CONSOLE_TIME_ZONE }).format(now);
}

/** A calendar date moved by whole days, for form defaults ("a year from today"). */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
