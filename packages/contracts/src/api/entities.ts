import { z } from 'zod';
import {
  Applicability,
  Criticality,
  Jurisdiction,
  ObligationDomain,
  RuleStatus,
  TimelineType,
} from '../enums.js';
import {
  CountryCode,
  Id,
  Instant,
  LocalDate,
  LongText,
  Month,
  Name,
  StateCode,
  Text,
} from '../primitives.js';
import { checkJurisdiction, RecurrenceRule, TemplateRef } from '../schemas/library.js';
import { ClientSettings, ReminderSettings } from '../schemas/tenancy.js';
import {
  checkHasChanges,
  csv,
  MAX_BULK_ITEMS,
  pageQueryShape,
  PersonRef,
  Reason,
  SearchText,
  versionField,
} from './common.js';

/** M6 · Library and entities (docs/contracts/endpoints.md §3). */

const nullableEmail = z.email().max(320).nullable();

// ---------- clients and settings ----------

export const ClientListQuery = z.strictObject({ ...pageQueryShape, q: SearchText.optional() });

/** New clients start from DEFAULT_CLIENT_SETTINGS unless settings are given. */
export const ClientCreateBody = z.strictObject({ name: Name, settings: ClientSettings.optional() });
export type ClientCreateBody = z.infer<typeof ClientCreateBody>;

export const ClientUpdateBody = z
  .strictObject({ ...versionField, name: Name })
  .superRefine(checkHasChanges);
export type ClientUpdateBody = z.infer<typeof ClientUpdateBody>;

/** `GET`/`PUT /clients/{clientId}/settings`. `version` is the client's. */
export const ClientSettingsView = z.strictObject({
  clientId: Id,
  ...versionField,
  settings: ClientSettings,
});
export type ClientSettingsView = z.infer<typeof ClientSettingsView>;

/**
 * Replaces the settings. A CLIENT_ADMIN may send only `reminders`; FIRM_ADMIN and CONSULTANT send `settings`.
 */
export const ClientSettingsBody = z
  .strictObject({
    ...versionField,
    settings: ClientSettings.optional(),
    reminders: ReminderSettings.optional(),
  })
  .refine((body) => (body.settings === undefined) !== (body.reminders === undefined), {
    message: 'Send either settings or reminders',
  });
export type ClientSettingsBody = z.infer<typeof ClientSettingsBody>;

// ---------- companies, units, locations ----------

export const EntityListQuery = z.strictObject({ ...pageQueryShape, q: SearchText.optional() });

export const CompanyCreateBody = z.strictObject({ name: Name });
export type CompanyCreateBody = z.infer<typeof CompanyCreateBody>;

export const CompanyUpdateBody = z
  .strictObject({ ...versionField, name: Name })
  .superRefine(checkHasChanges);
export type CompanyUpdateBody = z.infer<typeof CompanyUpdateBody>;

export const UnitListQuery = z.strictObject({
  ...pageQueryShape,
  companyId: Id.optional(),
  q: SearchText.optional(),
});

export const UnitCreateBody = z.strictObject({ companyId: Id, name: Name, locationId: Id });
export type UnitCreateBody = z.infer<typeof UnitCreateBody>;

export const UnitUpdateBody = z
  .strictObject({
    ...versionField,
    companyId: Id.optional(),
    name: Name.optional(),
    locationId: Id.optional(),
  })
  .superRefine(checkHasChanges);
export type UnitUpdateBody = z.infer<typeof UnitUpdateBody>;

export const LocationListQuery = z.strictObject({
  ...pageQueryShape,
  countryCode: CountryCode.optional(),
  stateCode: StateCode.optional(),
  q: SearchText.optional(),
});

export const LocationCreateBody = z.strictObject({
  country: Name,
  countryCode: CountryCode,
  state: Name.nullable(),
  stateCode: StateCode.nullable(),
  city: Name.nullable(),
});
export type LocationCreateBody = z.infer<typeof LocationCreateBody>;

// ---------- departments ----------

export const DepartmentCreateBody = z.strictObject({
  name: Name,
  aliases: z.array(Name).default([]),
});
export type DepartmentCreateBody = z.input<typeof DepartmentCreateBody>;

export const DepartmentUpdateBody = z
  .strictObject({ ...versionField, name: Name.optional(), aliases: z.array(Name).optional() })
  .superRefine(checkHasChanges);
export type DepartmentUpdateBody = z.infer<typeof DepartmentUpdateBody>;

// ---------- people and memberships ----------

export const PersonListQuery = z.strictObject({ ...pageQueryShape, q: SearchText.optional() });

/** Adds an UNCLAIMED person (no email) or one ready to invite. */
export const PersonCreateBody = z.strictObject({
  displayName: Name,
  email: nullableEmail.default(null),
});
export type PersonCreateBody = z.input<typeof PersonCreateBody>;

export const PersonUpdateBody = z
  .strictObject({ ...versionField, displayName: Name.optional(), email: nullableEmail.optional() })
  .superRefine(checkHasChanges);
export type PersonUpdateBody = z.infer<typeof PersonUpdateBody>;

/** Only the scope can change; a different role is a new membership. */
export const MembershipUpdateBody = z
  .strictObject({
    ...versionField,
    consultantClientIds: z.array(Id).nullable().optional(),
    unitIds: z.array(Id).min(1).nullable().optional(),
    expiresAt: Instant.nullable().optional(),
  })
  .superRefine(checkHasChanges);
export type MembershipUpdateBody = z.infer<typeof MembershipUpdateBody>;

// ---------- library ----------

export const LibraryListQuery = z.strictObject({ ...pageQueryShape, q: SearchText.optional() });

export const ActCreateBody = z
  .strictObject({
    name: Name,
    shortName: Name.nullable().default(null),
    jurisdiction: Jurisdiction,
    stateCode: StateCode.nullable().default(null),
    aliases: z.array(Name).default([]),
  })
  .superRefine(checkJurisdiction);
export type ActCreateBody = z.input<typeof ActCreateBody>;

/** The server re-checks jurisdiction against the merged record. */
export const ActUpdateBody = z
  .strictObject({
    ...versionField,
    name: Name.optional(),
    shortName: Name.nullable().optional(),
    jurisdiction: Jurisdiction.optional(),
    stateCode: StateCode.nullable().optional(),
    aliases: z.array(Name).optional(),
  })
  .superRefine(checkHasChanges);
export type ActUpdateBody = z.infer<typeof ActUpdateBody>;

export const CategoryCreateBody = z.strictObject({
  name: Name,
  aliases: z.array(Name).default([]),
});
export type CategoryCreateBody = z.input<typeof CategoryCreateBody>;

export const CategoryUpdateBody = z
  .strictObject({ ...versionField, name: Name.optional(), aliases: z.array(Name).optional() })
  .superRefine(checkHasChanges);
export type CategoryUpdateBody = z.infer<typeof CategoryUpdateBody>;

export const ObligationListQuery = z.strictObject({
  ...pageQueryShape,
  actId: csv(Id).optional(),
  categoryId: csv(Id).optional(),
  domain: csv(ObligationDomain).optional(),
  criticality: csv(Criticality).optional(),
  jurisdiction: Jurisdiction.optional(),
  stateCode: StateCode.optional(),
  ruleStatus: RuleStatus.optional(),
  q: SearchText.optional(),
});

const obligationFields = {
  externalRef: Text.max(100).nullable(),
  domain: ObligationDomain,
  jurisdiction: Jurisdiction,
  stateCode: StateCode.nullable(),
  actId: Id,
  categoryId: Id,
  title: Text.max(1000),
  description: LongText,
  applicabilityText: LongText.nullable(),
  criticality: Criticality,
  timelineType: TimelineType,
  recurrenceRule: RecurrenceRule,
  ruleStatus: RuleStatus,
  evidenceRequired: z.boolean(),
  forms: z.array(TemplateRef),
  logSheets: z.array(TemplateRef),
};

export const ObligationCreateBody = z.strictObject(obligationFields).superRefine(checkJurisdiction);
export type ObligationCreateBody = z.infer<typeof ObligationCreateBody>;

/** Each accepted change bumps `libraryVersion`; existing instances change only through `push`. */
export const ObligationUpdateBody = z
  .strictObject(obligationFields)
  .partial()
  .extend(versionField)
  .superRefine(checkHasChanges);
export type ObligationUpdateBody = z.infer<typeof ObligationUpdateBody>;

/** `POST /library/rules/preview`: the periods a rule would generate, before saving it. */
export const RulePreviewBody = z
  .strictObject({ rule: RecurrenceRule, from: LocalDate, to: LocalDate, fyStartMonth: Month })
  .refine((body) => body.to >= body.from, { path: ['to'], message: 'to is before from' });
export type RulePreviewBody = z.infer<typeof RulePreviewBody>;

/** Apply the obligation's current libraryVersion to future instances in these clients. */
export const ObligationPushBody = z.strictObject({
  clientIds: z.array(Id).min(1).max(MAX_BULK_ITEMS),
});
export type ObligationPushBody = z.infer<typeof ObligationPushBody>;

export const ObligationPushResult = z.strictObject({
  libraryVersion: z.int().min(1),
  assignmentsUpdated: z.int().min(0),
  instancesUpdated: z.int().min(0),
});
export type ObligationPushResult = z.infer<typeof ObligationPushResult>;

// ---------- assignments ----------

export const AssignmentListQuery = z.strictObject({
  ...pageQueryShape,
  unitId: csv(Id).optional(),
  departmentId: csv(Id).optional(),
  obligationId: csv(Id).optional(),
  applicability: csv(Applicability).optional(),
  ownerId: PersonRef.optional(),
  approverId: PersonRef.optional(),
});

export const AssignmentCreateBody = z
  .strictObject({
    unitId: Id,
    obligationId: Id,
    departmentId: Id,
    defaultOwnerId: Id,
    defaultApproverId: Id,
    activeFrom: LocalDate,
    activeTo: LocalDate.nullable().default(null),
  })
  .refine((a) => a.activeTo === null || a.activeTo >= a.activeFrom, {
    path: ['activeTo'],
    message: 'activeTo is before activeFrom',
  });
export type AssignmentCreateBody = z.input<typeof AssignmentCreateBody>;

export const AssignmentBulkBody = z.strictObject({
  items: z.array(AssignmentCreateBody).min(1).max(MAX_BULK_ITEMS),
});
export type AssignmentBulkBody = z.input<typeof AssignmentBulkBody>;

export const AssignmentUpdateBody = z
  .strictObject({
    ...versionField,
    departmentId: Id.optional(),
    defaultOwnerId: Id.optional(),
    defaultApproverId: Id.optional(),
    activeTo: LocalDate.nullable().optional(),
    /** Also reassign OPEN and SENT_BACK instances to the new defaults. */
    applyToOpen: z.boolean().optional(),
  })
  .superRefine(checkHasChanges);
export type AssignmentUpdateBody = z.infer<typeof AssignmentUpdateBody>;

/** NOT_APPLICABLE stops future generation; a reason is always required. */
export const AssignmentApplicabilityBody = z.strictObject({
  ...versionField,
  applicability: Applicability,
  reason: Reason,
});
export type AssignmentApplicabilityBody = z.infer<typeof AssignmentApplicabilityBody>;
