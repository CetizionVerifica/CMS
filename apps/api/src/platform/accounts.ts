import {
  ACCOUNT_DELETION_GRACE_DAYS,
  canMoveAccount,
  DEFAULT_TRIAL_DAYS,
  OWNER_INVITE_HOURS,
  type Account,
  type AccountProfile,
  type AccountStatus,
  type Entitlements,
  type LocalDate,
  type OperatorAuditAction,
  type Usage,
} from '@canopy/contracts';
import type { AccountRecord } from '@canopy/db';
import { addDays, localDateIn } from '@canopy/engine';
import { ApiError } from '../auth/index.js';

/** Dates the console works in when it does not say otherwise: the product's default time zone. */
export const OPERATOR_TIME_ZONE = 'Asia/Kolkata';

/** The operator's date today. */
export function operatorToday(now: Date): LocalDate {
  return localDateIn(now.toISOString(), OPERATOR_TIME_ZONE);
}

/** A new account's trial end: the one given, none when it goes ACTIVE at once, else 30 days from today. */
export function trialEndFor(
  body: { trialEndsOn?: LocalDate | undefined; activeNow: boolean },
  now: Date,
): LocalDate | null {
  if (body.activeNow) return null;
  return body.trialEndsOn ?? addDays(operatorToday(now), DEFAULT_TRIAL_DAYS);
}

export function ownerInviteExpiry(now: Date): string {
  return new Date(now.getTime() + OWNER_INVITE_HOURS * 3_600_000).toISOString();
}

/**
 * The profile as the contract shows it. Firms from before accounts have no profile yet: their legal name is their
 * name, and the time zone and FY start are the product defaults.
 */
export function profileOf(record: AccountRecord): AccountProfile {
  return {
    legalName: record.profile.legalName ?? record.name,
    gstin: record.profile.gstin ?? null,
    timeZone: record.profile.timeZone ?? OPERATOR_TIME_ZONE,
    fyStartMonth: record.profile.fyStartMonth ?? 4,
  };
}

/** The contract `Account`: the firm row, its entitlements and its counts. Never a person or a client row. */
export function accountOf(
  record: AccountRecord,
  entitlements: Entitlements,
  usage: Usage,
): Account {
  const purgeAfter =
    record.deletionRequestedAt === null
      ? null
      : new Date(
          Date.parse(record.deletionRequestedAt) + ACCOUNT_DELETION_GRACE_DAYS * 86_400_000,
        ).toISOString();
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    status: record.status,
    profile: profileOf(record),
    planCode: record.planCode,
    entitlements,
    usage: {
      companies: usage.companies,
      units: usage.units,
      users: usage.users,
      storageBytes: usage.storageBytes,
    },
    trialEndsOn: record.trialEndsOn,
    onboardedAt: record.onboardedAt,
    deletionRequestedAt: record.deletionRequestedAt,
    purgeAfter,
    createdAt: record.createdAt,
    version: record.version,
  };
}

/**
 * `POST /accounts/{id}/status`: which operator action a move is. Converting a trial, suspending and resuming are
 * the moves this route makes; anything else, or a move `ACCOUNT_TRANSITIONS` does not allow, is 409.
 */
export function statusMove(from: AccountStatus, to: 'ACTIVE' | 'SUSPENDED'): OperatorAuditAction {
  if (canMoveAccount(from, to)) {
    if (from === 'TRIAL' && to === 'ACTIVE') return 'TRIAL_CONVERT';
    if (to === 'SUSPENDED' && (from === 'TRIAL' || from === 'ACTIVE')) return 'ACCOUNT_SUSPEND';
    if (from === 'SUSPENDED' && to === 'ACTIVE') return 'ACCOUNT_RESUME';
  }
  throw new ApiError('INVALID_TRANSITION', { from, to });
}

/** Newest first, then id: the order `GET /accounts` pages in. */
export function newestFirst(a: AccountRecord, b: AccountRecord): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

/** Case-insensitive match on the account's name or legal name (`?q=`). */
export function matches(record: AccountRecord, q: string | undefined): boolean {
  if (q === undefined) return true;
  const text = q.toLowerCase();
  return [record.name, record.profile.legalName ?? ''].some((v) => v.toLowerCase().includes(text));
}

export function cursorOf(record: AccountRecord): string {
  return Buffer.from(`${record.createdAt}|${record.id}`).toString('base64url');
}

/** The records after the cursor, in `newestFirst` order. A cursor that is not one of ours is a 400. */
export function after(records: AccountRecord[], cursor: string | undefined): AccountRecord[] {
  if (cursor === undefined) return records;
  const [createdAt, id, ...rest] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (!createdAt || !id || rest.length > 0) {
    throw new ApiError('VALIDATION', { issues: [{ path: ['cursor'], message: 'Not a cursor' }] });
  }
  return records.filter((r) => r.createdAt < createdAt || (r.createdAt === createdAt && r.id < id));
}
