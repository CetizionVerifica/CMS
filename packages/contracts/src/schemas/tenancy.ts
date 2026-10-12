import { z } from 'zod';
import {
  CLIENT_ROLES,
  Criticality,
  FIRM_ROLES,
  HolidayPolicy,
  PersonStatus,
  Role,
} from '../enums.js';
import {
  baseShape,
  CountryCode,
  Id,
  Instant,
  LocalTime,
  Month,
  Name,
  StateCode,
  TimeZone,
  versionedShape,
} from '../primitives.js';

/** Tenancy, entities and people (docs/contracts/domain-model.md §3). */

export const FirmSettings = z.strictObject({
  criticalityWeights: z
    .record(Criticality, z.number().min(0).max(100))
    .refine((w) => Object.values(w).some((n) => n > 0), {
      message: 'At least one criticality weight must be above zero',
    }),
  dueSoonDays: z.int().min(0).max(90),
  /** Fixed true in v1. */
  mfaRequiredForFirmRoles: z.literal(true),
});
export type FirmSettings = z.infer<typeof FirmSettings>;

export const Firm = z.strictObject({
  ...baseShape,
  ...versionedShape,
  name: Name,
  settings: FirmSettings,
});
export type Firm = z.infer<typeof Firm>;

export const ReminderSettings = z.strictObject({
  ownerDaysBefore: z.array(z.int().min(0).max(90)).max(10),
  approverDaysAfter: z.array(z.int().min(0).max(90)).max(10),
  sendAtLocalTime: LocalTime,
  /** 1 = Monday ... 7 = Sunday (ISO weekday). */
  consultantDigestWeekday: z.int().min(1).max(7),
});
export type ReminderSettings = z.infer<typeof ReminderSettings>;

export const ClientSettings = z.strictObject({
  fyStartMonth: Month,
  timeZone: TimeZone,
  holidayPolicy: HolidayPolicy,
  reminders: ReminderSettings,
});
export type ClientSettings = z.infer<typeof ClientSettings>;

/** Customer organisation group, e.g. "Kestrel Metals Group". */
export const Client = z.strictObject({
  ...baseShape,
  ...versionedShape,
  name: Name,
  settings: ClientSettings,
});
export type Client = z.infer<typeof Client>;

/** e.g. "Kestrel Aluminium". */
export const Company = z.strictObject({
  ...baseShape,
  ...versionedShape,
  clientId: Id,
  name: Name,
});
export type Company = z.infer<typeof Company>;

/** Country / state / city. The state drives state-law applicability. */
export const Location = z.strictObject({
  ...baseShape,
  country: Name,
  countryCode: CountryCode,
  state: Name.nullable(),
  stateCode: StateCode.nullable(),
  city: Name.nullable(),
});
export type Location = z.infer<typeof Location>;

/** Plant, site or office, e.g. "Plant". */
export const Unit = z.strictObject({
  ...baseShape,
  ...versionedShape,
  clientId: Id,
  companyId: Id,
  name: Name,
  locationId: Id,
});
export type Unit = z.infer<typeof Unit>;

export const Department = z.strictObject({
  ...baseShape,
  ...versionedShape,
  clientId: Id,
  name: Name,
  /** Other spellings that resolve to this department on import, e.g. "HR". */
  aliases: z.array(Name),
});
export type Department = z.infer<typeof Department>;

export const Person = z
  .strictObject({
    ...baseShape,
    ...versionedShape,
    /** Title case for imported names. */
    displayName: Name,
    /** Lower-case with whitespace collapsed; the dedupe key per firm. */
    nameNormalized: Name,
    /** Null while UNCLAIMED. */
    email: z.email().nullable(),
    status: PersonStatus,
  })
  .superRefine((p, ctx) => {
    // Single spaces only: no tabs, newlines or runs of spaces.
    if (
      p.nameNormalized !== p.nameNormalized.toLowerCase() ||
      /[^\S ]| {2}/.test(p.nameNormalized)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['nameNormalized'],
        message: 'Must be lower-case with whitespace collapsed',
      });
    }
    if (p.status === 'UNCLAIMED' && p.email !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['email'],
        message: 'An UNCLAIMED person has no email',
      });
    }
    if ((p.status === 'INVITED' || p.status === 'ACTIVE') && p.email === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['email'],
        message: `A ${p.status} person needs an email`,
      });
    }
  });
export type Person = z.infer<typeof Person>;

const firmRoles: readonly Role[] = FIRM_ROLES;
const clientRoles: readonly Role[] = CLIENT_ROLES;

/** The role and scope fields every membership-shaped value has (memberships, invites, grants). */
interface MembershipScope {
  role: Role;
  clientId: string | null;
  consultantClientIds: readonly string[] | null;
  unitIds: readonly string[] | null;
  expiresAt: string | null;
}

/** Membership shape follows role (README decision 11). */
export function checkMembershipShape(m: MembershipScope, ctx: z.core.$RefinementCtx): void {
  if (firmRoles.includes(m.role) && m.clientId !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['clientId'],
      message: `${m.role} is a firm role; clientId must be null`,
    });
  }
  if (clientRoles.includes(m.role) && m.clientId === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['clientId'],
      message: `${m.role} is a client role; clientId is required`,
    });
  }
  if (m.role === 'CONSULTANT' && m.consultantClientIds === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['consultantClientIds'],
      message: 'A CONSULTANT lists the clients they see',
    });
  }
  if (m.role !== 'CONSULTANT' && m.consultantClientIds !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['consultantClientIds'],
      message: 'Only a CONSULTANT has consultantClientIds',
    });
  }
  if (m.unitIds !== null && m.role !== 'OWNER' && m.role !== 'APPROVER') {
    ctx.addIssue({
      code: 'custom',
      path: ['unitIds'],
      message: 'Only OWNER and APPROVER memberships are unit-scoped',
    });
  }
  if (m.role === 'VIEWER' && m.expiresAt === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['expiresAt'],
      message: 'A VIEWER membership needs expiresAt',
    });
  }
}

export const Membership = z
  .strictObject({
    ...baseShape,
    ...versionedShape,
    personId: Id,
    role: Role,
    /** Null for firm roles; required for client roles. */
    clientId: Id.nullable(),
    /** CONSULTANT only: the clients they may see. */
    consultantClientIds: z.array(Id).nullable(),
    /** OWNER and APPROVER scope; null = all units of the client. */
    unitIds: z.array(Id).min(1).nullable(),
    /** Required for VIEWER. */
    expiresAt: Instant.nullable(),
  })
  .superRefine(checkMembershipShape);
export type Membership = z.infer<typeof Membership>;
