import type { ClientSettings, FirmSettings } from './schemas/tenancy.js';

/** Default settings (PLAN.md §7, domain-model.md §3). Firms and clients override them. */

export const DEFAULT_FIRM_SETTINGS = {
  criticalityWeights: { SUPER_CRITICAL: 5, CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 },
  dueSoonDays: 7,
  mfaRequiredForFirmRoles: true,
} as const satisfies FirmSettings;

export const DEFAULT_CLIENT_SETTINGS = {
  fyStartMonth: 4,
  timeZone: 'Asia/Kolkata',
  holidayPolicy: 'NONE',
  reminders: {
    ownerDaysBefore: [7, 3, 0],
    approverDaysAfter: [1, 7],
    sendAtLocalTime: '07:00',
    consultantDigestWeekday: 1,
  },
} as const satisfies ClientSettings;

/** Customer account defaults (ADR M15-0001). Each can change without a new ADR. */

/** A new account's trial, in days from the day it is created, unless the operator sets another end date. */
export const DEFAULT_TRIAL_DAYS = 30;
/** Hours an account owner's invite link works for; the operator can resend it. */
export const OWNER_INVITE_HOURS = 72;
/** Days between a deletion request and the purge (ADR M15-0002). */
export const ACCOUNT_DELETION_GRACE_DAYS = 30;
/** Support access grants: default and longest length in days. */
export const SUPPORT_GRANT_DEFAULT_DAYS = 7;
export const SUPPORT_GRANT_MAX_DAYS = 30;
/** A support session ends after this many hours, or at the grant end if sooner. */
export const SUPPORT_SESSION_HOURS = 2;
/** Account for firms created before accounts existed, and the `Firm` defaults while a provider omits the fields. */
export const DEFAULT_ACCOUNT = {
  kind: 'CONSULTANCY',
  status: 'ACTIVE',
  planCode: 'CONSULTANCY',
  trialEndsOn: null,
} as const;
