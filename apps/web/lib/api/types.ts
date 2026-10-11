// Response shapes the shell reads that contracts v1 doesn't define yet. They are built from contract schemas so they
// stay close to the final ones. Pending M0: the `/me` response, the invite preview, and the per-client period context
// (which period is current comes from the engine, through the API). Replace each with the contract export when M0
// publishes it.
import { Client, FyLabel, Id, LocalDate, Membership, Name, Person } from '@canopy/contracts';
import { z } from 'zod';

const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM');

export const PeriodValue = z.strictObject({
  fy: FyLabel,
  quarter: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  month: Month.optional(),
});

/** What the top bar needs per client: unit count for the switcher, and the engine's period context for the picker. */
export const ClientShellInfo = z.strictObject({
  unitCount: z.int().min(0),
  /** The current quarter in the client's time zone, from the engine. */
  thisPeriod: PeriodValue,
  /** First FY with instances to the next one. */
  availableFys: z.array(FyLabel).min(1),
  /** Last month with generated instances, or null when none are generated yet. */
  availableUntil: Month.nullable(),
});
export type ClientShellInfo = z.infer<typeof ClientShellInfo>;

/** GET /me (endpoints.md §2: person, memberships, clients, csrf token, MFA state). */
export const MeResponse = z.strictObject({
  person: Person,
  memberships: z.array(Membership),
  clients: z.array(Client),
  csrfToken: z.string().min(16),
  mfaSatisfied: z.boolean(),
  /** Today in the firm's default time zone. */
  asOf: LocalDate,
  shell: z.record(Id, ClientShellInfo),
});
export type MeResponse = z.infer<typeof MeResponse>;

/** GET /invites/{token}: who the invite is for, shown before the person sets a password. */
export const InvitePreview = z.strictObject({
  displayName: Name,
  firmName: Name,
  clientName: Name.nullable(),
  email: z.email().nullable(),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type InvitePreview = z.infer<typeof InvitePreview>;

export const LoginRequest = z.strictObject({
  email: z.email('Enter a valid email address').max(320),
  password: z.string().min(1, 'Enter your password').max(200),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const MagicLinkRequest = z.strictObject({
  email: z.email('Enter a valid email address').max(320),
});

export const MfaVerifyRequest = z.strictObject({
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

export const AcceptInviteRequest = z
  .strictObject({
    email: z.email('Enter a valid email address').max(320),
    password: z
      .string()
      .min(12, 'Use at least 12 characters')
      .max(200, 'Use at most 200 characters'),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    path: ['confirm'],
    message: 'The passwords do not match',
  });

/** Writes that only acknowledge. */
export const Accepted = z.strictObject({ ok: z.literal(true) });
