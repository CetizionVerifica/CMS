import { z } from 'zod';
import { EntityType } from '../enums.js';
import { Id, LocalDate } from '../primitives.js';
import { Membership } from './tenancy.js';

/** Request context and policy shapes (docs/contracts/domain-model.md §8). M5 implements them. */

export const RequestContext = z.strictObject({
  requestId: z.string().min(1).max(200),
  firmId: Id,
  personId: Id,
  /** Active, non-expired memberships. */
  memberships: z.array(Membership),
  /** Every client this person may see. */
  clientIds: z.array(Id),
  mfaSatisfied: z.boolean(),
  /** Today in the client time zone of the request. */
  asOf: LocalDate,
});
export type RequestContext = z.infer<typeof RequestContext>;

/**
 * `can()` action name, "<resource>.<verb>" in lower camelCase, e.g. "instance.submit", "instance.dueDate". Listed in
 * docs/contracts/endpoints.md.
 */
export const Action = z
  .string()
  .regex(/^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/, 'Expected "<resource>.<verb>" in camelCase');
export type Action = z.infer<typeof Action>;

export const Resource = z.strictObject({
  type: EntityType,
  clientId: Id.nullable(),
  unitId: Id.optional(),
  /**
   * A record that spans several units (an ISO management system, internal audit or certificate, or a record that takes
   * its management system's units; docs/iso/plan.md §3.3). When present, a unit-scoped membership needs at least one of
   * them. Absent means the record has no unit list. A system whose `unitIds` is empty covers every unit of the client
   * (model §3.1): leave the field out then, never send `[]` (refused, which would fail closed). A record that takes
   * its system's units passes the system's list, or leaves the field out when that list is empty.
   */
  unitIds: z
    .array(Id)
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Units repeat' })
    .optional(),
  ownerId: Id.optional(),
  approverId: Id.optional(),
});
export type Resource = z.infer<typeof Resource>;

/** Policy check M5 implements; M0 ships a stub with the endpoints.md role matrix. */
export type Can = (ctx: RequestContext, action: Action, resource: Resource) => boolean;
