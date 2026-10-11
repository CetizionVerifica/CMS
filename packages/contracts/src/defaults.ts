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
