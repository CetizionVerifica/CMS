import { z } from 'zod';
import { IsoEntityType, IsoNotificationKind } from './enums.js';
import { Id, LocalDate } from './primitives.js';
import type { ClientSettings, FirmSettings } from './schemas/tenancy.js';

/** Default settings (PLAN.md §7, domain-model.md §3). Firms and clients override them. */

export const DEFAULT_FIRM_SETTINGS = {
  criticalityWeights: { SUPER_CRITICAL: 5, CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 },
  dueSoonDays: 7,
  mfaRequiredForFirmRoles: true,
  isoRisk: { significantAt: 12, legalLinkMakesSignificant: true },
} as const satisfies FirmSettings;

/** The ISO significance rule every firm uses in v1 (`FirmSettings.isoRisk`, docs/iso/model.md §5.1). */
export const DEFAULT_ISO_RISK_RULE = DEFAULT_FIRM_SETTINGS.isoRisk;

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
/** The one-time token that opens a support session works once, within this many seconds. */
export const SUPPORT_TOKEN_SECONDS = 60;
/** Account for firms created before accounts existed, and the `Firm` defaults while a provider omits the fields. */
export const DEFAULT_ACCOUNT = {
  kind: 'CONSULTANCY',
  status: 'ACTIVE',
  planCode: 'CONSULTANCY',
  trialEndsOn: null,
} as const;

/** ISO reminders (docs/iso/model.md §5.3, §7). ISO records are not instances, so they have their own send key. */

/** What M9 passes the engine per ISO subject, kind and anchor date, with the §7 recipients already resolved. */
export const IsoNotificationInput = z.strictObject({
  kind: IsoNotificationKind,
  isoSubjectType: IsoEntityType,
  isoSubjectId: Id,
  /** `dueOn`, `reviewDueOn`, `plannedStart`, `expiresOn`, a cycle due date, `responseDueOn`, `plannedOn`, ... */
  anchorDate: LocalDate,
  /** False for a DONE, CANCELLED, CLOSED, OBSOLETE or SUPERSEDED subject, or a met cycle date: nothing is planned. */
  open: z.boolean(),
  recipientIds: z.array(Id),
});
export type IsoNotificationInput = z.infer<typeof IsoNotificationInput>;

/** When one kind of reminder goes for one subject type: days from the anchor (negative before), then repeats. */
export const IsoReminderRule = z.strictObject({
  kind: IsoNotificationKind,
  isoSubjectType: IsoEntityType,
  offsetDays: z.array(z.int().min(-365).max(365)).min(1).max(10),
  /** Sends again this many days after the last offset while the item stays open; null sends no more. */
  repeatEveryDays: z.int().min(1).max(365).nullable(),
});
export type IsoReminderRule = z.infer<typeof IsoReminderRule>;

/** The ISO reminder schedule: one rule per kind and subject type. */
export const IsoReminderSchedule = z.array(IsoReminderRule).refine(
  (rules) => {
    const keys = rules.map((r) => `${r.kind} ${r.isoSubjectType}`);
    return new Set(keys).size === keys.length;
  },
  { message: 'One rule per kind and subject type' },
);
export type IsoReminderSchedule = z.infer<typeof IsoReminderSchedule>;

/** `planIsoNotifications` plans one per recipient, on the day it is due. */
export const PlannedIsoNotification = z.strictObject({
  kind: IsoNotificationKind,
  recipientId: Id,
  isoSubjectType: IsoEntityType,
  isoSubjectId: Id,
  sendDate: LocalDate,
  /** Days relative to the anchor date: negative before, positive after. */
  offsetDays: z.int(),
});
export type PlannedIsoNotification = z.infer<typeof PlannedIsoNotification>;

/**
 * An ISO reminder is sent at most once per these fields (`notification_send_iso_subject_key`), so two ISO records due
 * the same day for the same person are two sends, never merged with each other or with an instance's.
 */
export const ISO_NOTIFICATION_DEDUPE_KEY = [
  'isoSubjectType',
  'isoSubjectId',
  'kind',
  'sendDate',
  'recipientId',
] as const satisfies readonly (keyof PlannedIsoNotification)[];

/**
 * The default ISO reminder schedule (docs/iso/model.md §7 table; not editable in v1; M9 passes it to the engine).
 * A management review is reminded as a planned review and, separately, as an overdue system.
 */
export const ISO_REMINDER_SCHEDULE = [
  { kind: 'ISO_ACTION_DUE', isoSubjectType: 'iso_action', offsetDays: [-7, 0], repeatEveryDays: null },
  { kind: 'ISO_ACTION_OVERDUE', isoSubjectType: 'iso_action', offsetDays: [7], repeatEveryDays: null },
  {
    kind: 'ISO_REVIEW_DUE',
    isoSubjectType: 'controlled_document',
    offsetDays: [-14, 0],
    repeatEveryDays: null,
  },
  { kind: 'ISO_REVIEW_DUE', isoSubjectType: 'risk_item', offsetDays: [-14, 0], repeatEveryDays: null },
  {
    kind: 'ISO_AUDIT_STARTING',
    isoSubjectType: 'internal_audit',
    offsetDays: [-7, -1],
    repeatEveryDays: null,
  },
  {
    kind: 'ISO_CERTIFICATE_EXPIRING',
    isoSubjectType: 'certification',
    offsetDays: [-90, -30, -7],
    repeatEveryDays: null,
  },
  {
    kind: 'ISO_SURVEILLANCE_DUE',
    isoSubjectType: 'certification',
    offsetDays: [-60, -30],
    repeatEveryDays: null,
  },
  {
    kind: 'ISO_EXTERNAL_RESPONSE_DUE',
    isoSubjectType: 'external_audit',
    offsetDays: [-7, 0],
    repeatEveryDays: null,
  },
  {
    kind: 'ISO_MANAGEMENT_REVIEW_DUE',
    isoSubjectType: 'management_review',
    offsetDays: [-14, 0],
    repeatEveryDays: null,
  },
  {
    kind: 'ISO_MANAGEMENT_REVIEW_DUE',
    isoSubjectType: 'management_system',
    offsetDays: [0],
    repeatEveryDays: 30,
  },
  { kind: 'ISO_EFFECTIVENESS_DUE', isoSubjectType: 'nonconformity', offsetDays: [0], repeatEveryDays: null },
] as const satisfies IsoReminderSchedule;
