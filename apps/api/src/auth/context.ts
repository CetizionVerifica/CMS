import {
  DEFAULT_CLIENT_SETTINGS,
  type Membership,
  type PersonStatus,
  type RequestContext,
} from '@canopy/contracts';
import { localDateIn } from '@canopy/engine';
import { ApiError } from './errors.js';
import { isFirmRole } from './policy.js';

/** A stored session, looked up by the hash of its cookie token (the raw token is never stored). */
export interface SessionRecord {
  readonly id: string;
  readonly firmId: string;
  readonly personId: string;
  /** Compared with the `X-CSRF-Token` header on state-changing requests. */
  readonly csrfToken: string;
  /** True once the person passed MFA in this session. */
  readonly mfaSatisfied: boolean;
  readonly expiresAt: string;
}

/** What the request context is built from: the signed-in person and their firm. */
export interface Principal {
  readonly status: PersonStatus;
  /** Shown on `/me`. */
  readonly profile: { readonly name: string; readonly email: string | null };
  /** All of the person's memberships, including archived and expired ones. */
  readonly memberships: readonly Membership[];
  readonly mfaEnrolled: boolean;
  /** Firm setting `mfaRequiredForFirmRoles`. */
  readonly mfaRequiredForFirmRoles: boolean;
  /** Every client of the firm, archived ones included (a firm admin sees them all). */
  readonly firmClientIds: readonly string[];
}

/**
 * Storage the request context reads. M5 implements it on M3's repositories; tests use the in-memory store
 * in `testing.ts`.
 */
export interface AuthStore {
  findSession(tokenHash: string): Promise<SessionRecord | null>;
  loadPrincipal(firmId: string, personId: string): Promise<Principal | null>;
  /** The client's time zone setting, or null when the client is unknown. */
  clientTimeZone(firmId: string, clientId: string): Promise<string | null>;
}

/** Memberships that grant access at `now`: not archived and, for viewers, not past `expiresAt`. */
export function activeMemberships(memberships: readonly Membership[], now: Date): Membership[] {
  return memberships.filter(
    (m) =>
      m.archivedAt === null && (m.expiresAt === null || Date.parse(m.expiresAt) > now.getTime()),
  );
}

/** Every client the memberships let the person see, sorted. */
export function visibleClientIds(
  memberships: readonly Membership[],
  firmClientIds: readonly string[],
): string[] {
  const ids = new Set<string>();
  for (const m of memberships) {
    if (m.role === 'FIRM_ADMIN') firmClientIds.forEach((id) => ids.add(id));
    else if (m.role === 'CONSULTANT') (m.consultantClientIds ?? []).forEach((id) => ids.add(id));
    else if (m.clientId !== null) ids.add(m.clientId);
  }
  return [...ids].sort();
}

/** True when the person holds a firm role and the firm requires MFA for firm roles. */
export function mfaRequired(principal: Principal, active: readonly Membership[]): boolean {
  return principal.mfaRequiredForFirmRoles && active.some((m) => isFirmRole(m.role));
}

export interface BuildContextInput {
  readonly requestId: string;
  readonly session: SessionRecord | null;
  readonly principal: Principal | null;
  readonly now: Date;
  /** The time zone `asOf` is computed in: the client's for client routes, else the default. */
  readonly timeZone?: string;
  /** Routes that complete MFA (enroll, verify, `/me`, logout) are reachable before MFA. */
  readonly allowBeforeMfa?: boolean;
}

/**
 * Builds the request context for a session, or throws the contract error:
 * `UNAUTHENTICATED` (no, expired or orphaned session; person not ACTIVE), `ACCESS_EXPIRED` (every
 * membership has expired), `FORBIDDEN` (no membership at all), `MFA_REQUIRED` (firm role without MFA in
 * this session, unless `allowBeforeMfa`).
 */
export function buildRequestContext(input: BuildContextInput): RequestContext {
  const { session, principal, now } = input;
  if (session === null || Date.parse(session.expiresAt) <= now.getTime()) {
    throw new ApiError('UNAUTHENTICATED');
  }
  if (principal === null || principal.status !== 'ACTIVE') throw new ApiError('UNAUTHENTICATED');

  const active = activeMemberships(principal.memberships, now);
  if (active.length === 0) {
    const expired = principal.memberships.some((m) => m.archivedAt === null);
    throw new ApiError(expired ? 'ACCESS_EXPIRED' : 'FORBIDDEN');
  }
  if (!session.mfaSatisfied && !input.allowBeforeMfa && mfaRequired(principal, active)) {
    throw new ApiError('MFA_REQUIRED', { enrolled: principal.mfaEnrolled });
  }

  return {
    requestId: input.requestId,
    firmId: session.firmId,
    personId: session.personId,
    memberships: active,
    clientIds: visibleClientIds(active, principal.firmClientIds),
    mfaSatisfied: session.mfaSatisfied,
    asOf: localDateIn(now.toISOString(), input.timeZone ?? DEFAULT_CLIENT_SETTINGS.timeZone),
  };
}
