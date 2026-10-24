import { AccountStatus, Id, PersonStatus } from '@canopy/contracts';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from './errors.js';

/**
 * Sign-in reads that run before a tenant is known (ADR M3-0001). Each is one SECURITY DEFINER function owned
 * by `canopy_lookup` (migration 0012) that returns ids, hashes and states only, never an MFA secret.
 */

/** A person who may sign in with an email, in one firm. */
export const LoginCandidate = z.strictObject({
  firmId: Id,
  personId: Id,
  firmName: z.string(),
  status: PersonStatus,
  passwordHash: z.string().nullable(),
  lockedUntil: z.iso.datetime().nullable(),
  /** The account's status (ADR M15-0001 decision 4); check it after the password, never before. */
  accountStatus: AccountStatus,
});
export type LoginCandidate = z.infer<typeof LoginCandidate>;

/**
 * A session that has not been revoked, and for a support session whose grant is still live. The caller checks
 * `expiresAt` and `accountStatus`.
 */
export const SessionLookup = z.strictObject({
  id: Id,
  firmId: Id,
  personId: Id,
  csrfToken: z.string(),
  mfaSatisfied: z.boolean(),
  expiresAt: z.iso.datetime(),
  accountStatus: AccountStatus,
  /** Set on a PlanetPulse support session (ADR M15-0001 decision 11). */
  supportGrantId: Id.nullable(),
});
export type SessionLookup = z.infer<typeof SessionLookup>;

export const LoginTokenKind = z.enum(['MAGIC_LINK', 'INVITE']);
export type LoginTokenKind = z.infer<typeof LoginTokenKind>;

/** A sign-in link, used or not; `inviteOpen` says whether its invite is still open (false for magic links). */
export const LoginTokenLookup = z.strictObject({
  id: Id,
  firmId: Id,
  personId: Id,
  kind: LoginTokenKind,
  inviteId: Id.nullable(),
  tokenHash: z.string(),
  expiresAt: z.iso.datetime(),
  usedAt: z.iso.datetime().nullable(),
  inviteOpen: z.boolean(),
});
export type LoginTokenLookup = z.infer<typeof LoginTokenLookup>;

/**
 * A one-time support token the operator console issued, used or not. `grantLive` says whether its grant is
 * neither revoked nor over; the caller checks it, `expiresAt`, `usedAt` and `accountStatus`.
 */
export const SupportTokenLookup = z.strictObject({
  id: Id,
  firmId: Id,
  personId: Id,
  supportGrantId: Id,
  grantEndsAt: z.iso.datetime(),
  grantLive: z.boolean(),
  accountStatus: AccountStatus,
  expiresAt: z.iso.datetime(),
  usedAt: z.iso.datetime().nullable(),
});
export type SupportTokenLookup = z.infer<typeof SupportTokenLookup>;

/** The SHA-256 of a token, lower-case hex: the only form tokens are stored or looked up in. */
export const TokenHash = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a SHA-256 hex digest');

const Email = z.string().trim().min(3).max(320);

/** Drizzle's driver returns timestamptz as Postgres text; contracts want ISO 8601 UTC. */
const iso = (value: unknown) =>
  value instanceof Date || typeof value === 'string' ? new Date(value).toISOString() : value;

type Execute = (query: SQL) => Promise<{ rows: Record<string, unknown>[] }>;

export function lookups(execute: Execute) {
  return {
    async findLoginCandidates(email: string): Promise<LoginCandidate[]> {
      const { rows } = await execute(sql`
        SELECT firm_id, person_id, firm_name, status, password_hash, locked_until, account_status
        FROM canopy_login_candidates(${validate(Email, email)})`);
      return rows.map((r) =>
        validate(LoginCandidate, {
          firmId: r.firm_id,
          personId: r.person_id,
          firmName: r.firm_name,
          status: r.status,
          passwordHash: r.password_hash,
          lockedUntil: iso(r.locked_until),
          accountStatus: r.account_status,
        }),
      );
    },
    async findSession(tokenHash: string): Promise<SessionLookup | null> {
      const { rows } = await execute(sql`
        SELECT id, firm_id, person_id, csrf_token, mfa_satisfied, expires_at, account_status, support_grant_id
        FROM canopy_find_session(${validate(TokenHash, tokenHash)})`);
      const [r] = rows;
      if (!r) return null;
      return validate(SessionLookup, {
        id: r.id,
        firmId: r.firm_id,
        personId: r.person_id,
        csrfToken: r.csrf_token,
        mfaSatisfied: r.mfa_satisfied,
        expiresAt: iso(r.expires_at),
        accountStatus: r.account_status,
        supportGrantId: r.support_grant_id,
      });
    },
    async findSupportToken(tokenHash: string): Promise<SupportTokenLookup | null> {
      const { rows } = await execute(sql`
        SELECT id, firm_id, person_id, support_grant_id, grant_ends_at, grant_live, account_status, expires_at, used_at
        FROM canopy_find_support_token(${validate(TokenHash, tokenHash)})`);
      const [r] = rows;
      if (!r) return null;
      return validate(SupportTokenLookup, {
        id: r.id,
        firmId: r.firm_id,
        personId: r.person_id,
        supportGrantId: r.support_grant_id,
        grantEndsAt: iso(r.grant_ends_at),
        grantLive: r.grant_live,
        accountStatus: r.account_status,
        expiresAt: iso(r.expires_at),
        usedAt: iso(r.used_at),
      });
    },
    async findLoginToken(tokenHash: string): Promise<LoginTokenLookup | null> {
      const { rows } = await execute(sql`
        SELECT id, firm_id, person_id, kind, invite_id, token_hash, expires_at, used_at, invite_open
        FROM canopy_find_login_token(${validate(TokenHash, tokenHash)})`);
      const [r] = rows;
      if (!r) return null;
      return validate(LoginTokenLookup, {
        id: r.id,
        firmId: r.firm_id,
        personId: r.person_id,
        kind: r.kind,
        inviteId: r.invite_id,
        tokenHash: r.token_hash,
        expiresAt: iso(r.expires_at),
        usedAt: iso(r.used_at),
        inviteOpen: r.invite_open,
      });
    },
  };
}

export type AuthLookups = ReturnType<typeof lookups>;
