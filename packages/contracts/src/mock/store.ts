// In-memory state of the mock API: both fixture firms plus what the fixtures do not hold (sessions, invites,
// imports, exports). Every request reads and writes this; `reset()` reloads the fixtures.
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Invite } from '../api/auth.js';
import type { SupportGrant } from '../schemas/accounts.js';
import { CLIENT_ROLES, FIRM_ROLES, type Role } from '../enums.js';
import { type FixtureSet as FixtureSetSchema } from '../fixtures/schema.js';
import { loadFixtureSet } from '../fixtures/index.js';
import type { ImportBatch, ImportIssue, ImportRow, MappingTemplate } from '../schemas/import.js';
import type { ExportJob } from '../schemas/scores.js';

/** Fixture rows as plain JSON (schema input types), so handlers can write plain date strings. */
export type FirmData = z.input<typeof FixtureSetSchema>;
export type Row<K extends keyof FirmData> = FirmData[K] extends (infer T)[] ? T : never;
export type InstanceRecord = Row<'instances'>;
export type PersonRecord = Row<'people'>;
export type MembershipRecord = Row<'memberships'>;

type Plain<T extends z.ZodType> = z.input<T>;

export interface ImportState {
  batch: Plain<typeof ImportBatch>;
  rows: Plain<typeof ImportRow>[];
  issues: Plain<typeof ImportIssue>[];
}

export interface FirmState {
  data: FirmData;
  /** `mfaSetUp`: the invitee asked `POST /invites/{token}/mfa/enroll` for an authenticator (F14). */
  invites: (Plain<typeof Invite> & { token: string; mfaSetUp?: boolean })[];
  imports: ImportState[];
  /** Upload tickets issued by `POST /clients/{clientId}/imports`, keyed by batch id. */
  pendingImports: Map<string, { clientId: string; fileName: string; createdById: string }>;
  /** Evidence upload tickets, keyed by upload id. */
  pendingUploads: Map<
    string,
    { instanceId: string; fileName: string; mimeType: string; sizeBytes: number }
  >;
  mappingTemplates: Plain<typeof MappingTemplate>[];
  exports: Plain<typeof ExportJob>[];
  /** Evidence confirmed through the mock whose scan finishes on the next read. */
  scanning: Set<string>;
  /** PlanetPulse support access grants (M15). */
  supportGrants: Plain<typeof SupportGrant>[];
}

/** How long a mock session reports it lasts. */
const SESSION_HOURS = 12;

export interface Session {
  id: string;
  firmId: string;
  personId: string;
  csrfToken: string;
  mfaSatisfied: boolean;
  /** Header sessions (`X-Mock-Person`) skip CSRF, for tests and scripts. */
  viaHeader: boolean;
  /** Reported in `Me.session`. The mock ends a session at this time only when `capped` (support sessions). */
  expiresAt: string;
  /** Support sessions end at `expiresAt`: the earlier of 2 hours and the grant end. */
  capped?: boolean;
}

/** An email the real API would send; the mock keeps it for `GET /__mock/outbox` instead. */
export interface OutboxMessage {
  to: string;
  kind: 'MAGIC_LINK' | 'INVITE';
  token: string;
  at: string;
}

export class MockStore {
  firms: FirmState[] = [];
  sessions = new Map<string, Session>();
  magicLinks = new Map<string, { firmId: string; personId: string }>();
  idempotency = new Map<string, { status: number; body: unknown }>();
  outbox: OutboxMessage[] = [];
  /** One-time support-session tokens from `POST /__mock/support-sessions/{grantId}`, each valid until `expiresAt`. */
  supportTokens = new Map<string, { firmId: string; grantId: string; expiresAt: string }>();
  private sequence = 0;

  constructor(
    private readonly sets: readonly ('firm-a.sample' | 'firm-b.synthetic')[] = [
      'firm-a.sample',
      'firm-b.synthetic',
    ],
  ) {
    this.reset();
  }

  reset(): void {
    this.firms = this.sets.map((name) => ({
      data: structuredClone(loadFixtureSet(name)) as FirmData,
      invites: [],
      imports: [],
      pendingImports: new Map(),
      pendingUploads: new Map(),
      mappingTemplates: [],
      exports: [],
      scanning: new Set(),
      supportGrants: [],
    }));
    this.sessions.clear();
    this.magicLinks.clear();
    this.idempotency.clear();
    this.outbox = [];
    this.supportTokens.clear();
    this.sequence = 0;
  }

  /** A new id. Random v4 is enough for a mock; servers use v7. */
  newId(): string {
    return randomUUID();
  }

  /** Request ids and other opaque tokens. */
  token(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence.toString().padStart(6, '0')}-${randomUUID().replaceAll('-', '')}`;
  }

  firm(firmId: string): FirmState {
    const firm = this.firms.find((f) => f.data.firm.id === firmId);
    if (firm === undefined) throw new Error(`No firm ${firmId}`);
    return firm;
  }

  /**
   * Every person with this email, across firms (emails are unique per firm). Support people never match, so they get
   * no password sign-in, magic link or firm choice (ADR M15-0001 decision 11).
   */
  findByEmail(email: string): { firm: FirmState; person: PersonRecord }[] {
    const wanted = email.toLowerCase();
    return this.firms.flatMap((firm) =>
      firm.data.people
        .filter(
          (p) => p.archivedAt === null && p.support !== true && p.email?.toLowerCase() === wanted,
        )
        .map((person) => ({ firm, person })),
    );
  }

  findPerson(personId: string): { firm: FirmState; person: PersonRecord } | undefined {
    for (const firm of this.firms) {
      const person = firm.data.people.find((p) => p.id === personId && p.archivedAt === null);
      if (person) return { firm, person };
    }
    return undefined;
  }

  openSession(firmId: string, personId: string, viaHeader: boolean, now: string): Session {
    const memberships = activeMemberships(this.firm(firmId), personId, now);
    const session: Session = {
      id: this.token('session'),
      firmId,
      personId,
      csrfToken: this.token('csrf'),
      mfaSatisfied: viaHeader || !memberships.some((m) => isFirmRole(m.role)),
      viaHeader,
      expiresAt: new Date(Date.parse(now) + SESSION_HOURS * 3_600_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z'),
    };
    this.sessions.set(session.id, session);
    return session;
  }
}

export const isFirmRole = (role: Role) => (FIRM_ROLES as readonly Role[]).includes(role);
export const isClientRole = (role: Role) => (CLIENT_ROLES as readonly Role[]).includes(role);

/** Memberships that are live now: not archived and, for VIEWER, not past `expiresAt`. */
export function activeMemberships(
  firm: FirmState,
  personId: string,
  now: string,
): MembershipRecord[] {
  return firm.data.memberships.filter(
    (m) =>
      m.personId === personId &&
      m.archivedAt === null &&
      (m.expiresAt === null || m.expiresAt > now),
  );
}
