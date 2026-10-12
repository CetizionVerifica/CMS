import { z } from 'zod';
import { Role } from '../enums.js';
import { baseShape, Id, Instant, Name } from '../primitives.js';
import { checkMembershipShape, Membership, Person } from '../schemas/tenancy.js';

/** M5 · Auth, sessions and invites (docs/contracts/endpoints.md §2). */

const Email = z.email().max(320);
const Password = z.string().min(12).max(200);

export const LoginBody = z.strictObject({ email: Email, password: Password });
export type LoginBody = z.infer<typeof LoginBody>;

export const MagicLinkBody = z.strictObject({ email: Email });
export type MagicLinkBody = z.infer<typeof MagicLinkBody>;

export const MagicLinkVerifyBody = z.strictObject({ token: z.string().min(16).max(500) });
export type MagicLinkVerifyBody = z.infer<typeof MagicLinkVerifyBody>;

/** TOTP enrolment: the authenticator app reads `otpauthUrl` (usually shown as a QR code). */
export const MfaEnrollment = z.strictObject({ otpauthUrl: z.string().startsWith('otpauth://') });
export type MfaEnrollment = z.infer<typeof MfaEnrollment>;

export const MfaVerifyBody = z.strictObject({
  code: z.string().regex(/^\d{6}$/, 'Expected 6 digits'),
});
export type MfaVerifyBody = z.infer<typeof MfaVerifyBody>;

/** A client the signed-in person may open, for the client switcher. */
export const ClientSummary = z.strictObject({ id: Id, name: Name });
export type ClientSummary = z.infer<typeof ClientSummary>;

/** `GET /me`: who is signed in and what they may see. Login, magic-link verify and MFA verify return it too. */
export const Me = z.strictObject({
  person: Person,
  /** Active, non-expired memberships. */
  memberships: z.array(Membership),
  /** Every client this person may see, by name. */
  clients: z.array(ClientSummary),
  /** Send as `X-CSRF-Token` on every state-changing request. */
  csrfToken: z.string().min(16),
  mfa: z.strictObject({
    /** Firm roles must enrol before they can use the app. */
    required: z.boolean(),
    enrolled: z.boolean(),
    /** True once this session has passed MFA. */
    satisfied: z.boolean(),
  }),
});
export type Me = z.infer<typeof Me>;

/** The role and scope a membership grants; shared by invites and `POST /people/{id}/memberships`. */
const membershipGrantShape = {
  role: Role,
  clientId: Id.nullable(),
  consultantClientIds: z.array(Id).nullable(),
  unitIds: z.array(Id).min(1).nullable(),
  expiresAt: Instant.nullable(),
};

export const MembershipGrant = z
  .strictObject(membershipGrantShape)
  .superRefine(checkMembershipShape);
export type MembershipGrant = z.infer<typeof MembershipGrant>;

export const InviteStatus = z.enum(['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED']);
export type InviteStatus = z.infer<typeof InviteStatus>;

/** An invitation to claim a person and start a membership. The token is only ever in the email link. */
export const Invite = z.strictObject({
  ...baseShape,
  personId: Id,
  email: Email,
  ...membershipGrantShape,
  status: InviteStatus,
  invitedById: Id,
  /** Invite links work for 7 days. */
  linkExpiresAt: Instant,
});
export type Invite = z.infer<typeof Invite>;

/**
 * `POST /invites`. Names an existing person (e.g. an UNCLAIMED owner from an import) or creates one.
 * CONSULTANT and CLIENT_ADMIN may invite only client roles in their clients; only FIRM_ADMIN invites firm roles.
 */
export const InviteBody = z
  .strictObject({
    personId: Id.optional(),
    displayName: Name.optional(),
    email: Email,
    ...membershipGrantShape,
  })
  .superRefine((body, ctx) => {
    if ((body.personId === undefined) === (body.displayName === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['personId'],
        message: 'Give personId for an existing person or displayName for a new one',
      });
    }
    checkMembershipShape(body, ctx);
  });
export type InviteBody = z.infer<typeof InviteBody>;

export const InviteTokenParams = z.strictObject({ token: z.string().min(16).max(500) });

/** `GET /invites/{token}`: what the accept page shows before sign-up. Public, so no ids. */
export const InvitePreview = z.strictObject({
  email: Email,
  displayName: Name,
  firmName: Name,
  clientName: Name.nullable(),
  role: Role,
  linkExpiresAt: Instant,
});
export type InvitePreview = z.infer<typeof InvitePreview>;

export const InviteAcceptBody = z.strictObject({
  password: Password,
  /** Lets the person correct the name an import gave them. */
  displayName: Name.optional(),
});
export type InviteAcceptBody = z.infer<typeof InviteAcceptBody>;
