import { Id, type RequestContext } from '@canopy/contracts';
import { z } from 'zod';

/**
 * Who a database transaction acts for. `withTenant` turns it into transaction-local settings that every
 * RLS policy reads (packages/db/CLAUDE.md rule 2).
 */
export interface TenantContext {
  /** The tenant. Every row read or written belongs to this firm. */
  readonly firmId: string;
  /** The acting person, or null for system jobs and imports. */
  readonly personId: string | null;
  /** Clients the transaction may see, or 'ALL' for firm-wide work (firm admins, system jobs). */
  readonly clientIds: readonly string[] | 'ALL';
  /**
   * Firm staff (firm admins, consultants, system jobs) may change firm-wide rows (firm settings, library)
   * and see every person of the firm. Default: true exactly when `clientIds` is 'ALL'.
   */
  readonly firmStaff?: boolean;
  /** Correlates audit rows and logs with the request or job. */
  readonly requestId: string;
}

const TenantContextSchema = z.strictObject({
  firmId: Id,
  personId: Id.nullable(),
  clientIds: z.union([z.literal('ALL'), z.array(Id).max(10_000)]),
  firmStaff: z.boolean().optional(),
  requestId: z.string().min(1).max(200),
});

/** The transaction-local settings for a context, as `set_config` arguments. */
export interface TenantSettings {
  readonly 'app.firm_id': string;
  readonly 'app.person_id': string;
  readonly 'app.client_ids': string;
  readonly 'app.all_clients': 'on' | 'off';
  readonly 'app.firm_staff': 'on' | 'off';
  readonly 'app.request_id': string;
}

/** Validates a context and renders its settings. Throws on anything that is not a well-formed context. */
export function tenantSettings(ctx: TenantContext): TenantSettings {
  const parsed = TenantContextSchema.parse(ctx);
  const all = parsed.clientIds === 'ALL';
  return {
    'app.firm_id': parsed.firmId,
    'app.person_id': parsed.personId ?? '',
    'app.client_ids': all ? '' : `{${(parsed.clientIds as string[]).join(',')}}`,
    'app.all_clients': all ? 'on' : 'off',
    'app.firm_staff': (parsed.firmStaff ?? all) ? 'on' : 'off',
    'app.request_id': parsed.requestId,
  };
}

/**
 * The tenant context for an API request (M5 builds the RequestContext). A FIRM_ADMIN works across every
 * client of the firm, including ones created in the same request; everyone else sees `ctx.clientIds`.
 * Firm admins and consultants are firm staff.
 */
export function tenantFromRequest(ctx: RequestContext): TenantContext {
  const active = ctx.memberships.filter((m) => m.archivedAt === null);
  const firmWide = active.some((m) => m.role === 'FIRM_ADMIN');
  return {
    firmId: ctx.firmId,
    personId: ctx.personId,
    clientIds: firmWide ? 'ALL' : ctx.clientIds,
    firmStaff: active.some((m) => m.role === 'FIRM_ADMIN' || m.role === 'CONSULTANT'),
    requestId: ctx.requestId,
  };
}

/** Context for background jobs and imports acting for a whole firm. */
export function systemContext(firmId: string, requestId: string): TenantContext {
  return { firmId, personId: null, clientIds: 'ALL', firmStaff: true, requestId };
}
