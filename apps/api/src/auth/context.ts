import {
  DEFAULT_CLIENT_SETTINGS,
  EXPORT_ACCOUNT_STATUSES,
  WORKING_ACCOUNT_STATUSES,
  type AccountStatus,
  type Membership,
  type Person,
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
  /** The account's status when the session was looked up (ADR M15-0001 decision 4). Missing reads as ACTIVE. */
  readonly accountStatus?: AccountStatus;
  /** Set on a PlanetPulse support session; such a session is not found once its grant ends. */
  readonly supportGrantId?: string | null;
}

/** What the request context is built from: the signed-in person and their firm. */
export interface Principal {
  /** The M0 `Person`, returned on `/me`; only ACTIVE people can have a session. */
  readonly person: Person;
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
  /**
   * The account's features (`Entitlements.features`: plan ∪ added − removed), read fresh on every call so an operator's
   * switch takes effect on the next request (ADR M16-0001). A store without it has no features: add-on routes refuse.
   */
  accountFeatures?(firmId: string): Promise<readonly string[]>;
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
  /**
   * Routes an account admin may still use while the account is PENDING_DELETION: `/me`, logout and the account
   * export (endpoints.md §8). Every other route answers ACCOUNT_SUSPENDED then.
   */
  readonly allowWhilePendingDeletion?: boolean;
}

const working: readonly AccountStatus[] = WORKING_ACCOUNT_STATUSES;
const exporting: readonly AccountStatus[] = EXPORT_ACCOUNT_STATUSES;

/**
 * Throws ACCOUNT_SUSPENDED unless the account lets this person in here: everyone while TRIAL or ACTIVE; while
 * PENDING_DELETION, account admins (not PlanetPulse support) on the routes that allow it; nobody otherwise.
 */
export function checkAccount(
  status: AccountStatus,
  active: readonly Membership[],
  options: { support: boolean; allowWhilePendingDeletion: boolean },
): void {
  if (working.includes(status)) return;
  const admin = active.some((m) => m.role === 'FIRM_ADMIN');
  if (exporting.includes(status) && admin && !options.support && options.allowWhilePendingDeletion)
    return;
  throw new ApiError('ACCOUNT_SUSPENDED', { status });
}

/**
 * Builds the request context for a session, or throws the contract error:
 * `UNAUTHENTICATED` (no, expired or orphaned session; person not ACTIVE), `ACCESS_EXPIRED` (every
 * membership has expired), `FORBIDDEN` (no membership at all), `ACCOUNT_SUSPENDED` (the account is not working,
 * see `checkAccount`), `MFA_REQUIRED` (firm role without MFA in this session, unless `allowBeforeMfa`).
 */
export function buildRequestContext(input: BuildContextInput): RequestContext {
  const { session, principal, now } = input;
  if (session === null || Date.parse(session.expiresAt) <= now.getTime()) {
    throw new ApiError('UNAUTHENTICATED');
  }
  if (principal === null || principal.person.status !== 'ACTIVE')
    throw new ApiError('UNAUTHENTICATED');

  const active = activeMemberships(principal.memberships, now);
  if (active.length === 0) {
    const expired = principal.memberships.some((m) => m.archivedAt === null);
    throw new ApiError(expired ? 'ACCESS_EXPIRED' : 'FORBIDDEN');
  }
  checkAccount(session.accountStatus ?? 'ACTIVE', active, {
    support: (session.supportGrantId ?? null) !== null,
    allowWhilePendingDeletion: input.allowWhilePendingDeletion ?? false,
  });
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
