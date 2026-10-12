import { Id, Instant, Role } from '@canopy/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AccountStore } from './accounts.js';
import { mfaRequired } from './context.js';
import { ApiError } from './errors.js';
import { Password } from './passwords.js';
import { sessionOf, SESSION_COOKIE } from './plugin.js';
import type { SecretBox } from './secretbox.js';
import { AuthService, type IssuedSession } from './service.js';

/** Request bodies (endpoints.md §2). Local until M0 ships the auth request schemas. */
const Email = z.email().max(320);
export const LoginBody = z.strictObject({
  email: Email,
  password: z.string().min(1).max(1024),
  firmId: Id.optional(),
});
export const MagicLinkBody = z.strictObject({ email: Email });
export const TokenBody = z.strictObject({ token: z.string().min(20).max(200) });
export const MfaCodeBody = z.strictObject({ code: z.string().regex(/^\d{6}$/) });
export const AcceptInviteBody = z.strictObject({ password: Password });
export const InviteBody = z.strictObject({
  personId: Id,
  email: Email,
  role: Role,
  clientId: Id.nullable(),
  consultantClientIds: z.array(Id).max(10_000).nullable().default(null),
  unitIds: z.array(Id).min(1).max(10_000).nullable().default(null),
  expiresAt: Instant.nullable().default(null),
});
const TokenParams = z.strictObject({ token: z.string().min(20).max(200) });
const IdParams = z.strictObject({ id: Id });

export interface AuthRoutesOptions {
  readonly store: AccountStore;
  readonly secrets: SecretBox;
  readonly clock?: () => Date;
  /** `Secure` on the session cookie. Default: on unless NODE_ENV is development or test. */
  readonly secureCookies?: boolean;
}

/** Per-IP limits on the routes people can hit without a session (api-conventions §5 `RATE_LIMITED`). */
const LIMITS = {
  login: { max: 10, timeWindow: '1 minute' },
  magicLink: { max: 5, timeWindow: '1 minute' },
  token: { max: 20, timeWindow: '1 minute' },
  mfa: { max: 10, timeWindow: '1 minute' },
} as const;

/**
 * The M5 auth routes, registered under `/api/v1`. The service object is returned so jobs (M9) can call
 * `issueLoginToken` when they send magic-link and invite emails.
 */
export function registerAuthRoutes(app: FastifyInstance, options: AuthRoutesOptions): AuthService {
  const service = new AuthService(options);
  const secure =
    options.secureCookies ?? !['development', 'test'].includes(process.env.NODE_ENV ?? '');

  function setSessionCookie(reply: FastifyReply, session: IssuedSession) {
    reply.setCookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      expires: new Date(session.expiresAt),
    });
    return {
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
      mfa: { required: session.mfaRequired, enrolled: session.mfaEnrolled, satisfied: false },
    };
  }

  void app.register(
    async (api) => {
      api.post(
        '/auth/login',
        { config: { auth: 'public', routeLimit: LIMITS.login } },
        async (req, reply) => {
          const result = await service.login(LoginBody.parse(req.body), req.id);
          if (result.status === 'CHOOSE_FIRM')
            return { status: result.status, firms: result.firms };
          return { status: result.status, ...setSessionCookie(reply, result.session) };
        },
      );

      api.post(
        '/auth/magic-link',
        { config: { auth: 'public', routeLimit: LIMITS.magicLink } },
        async (req, reply) => {
          await service.requestMagicLink(MagicLinkBody.parse(req.body).email, req.id);
          return reply.code(202).send({ status: 'ACCEPTED' });
        },
      );

      api.post(
        '/auth/magic-link/verify',
        { config: { auth: 'public', routeLimit: LIMITS.token } },
        async (req, reply) => {
          const session = await service.verifyMagicLink(TokenBody.parse(req.body).token, req.id);
          return { status: 'OK', ...setSessionCookie(reply, session) };
        },
      );

      api.post('/auth/logout', { config: { auth: 'session-pre-mfa' } }, async (req, reply) => {
        await service.logout(sessionOf(req).id);
        reply.clearCookie(SESSION_COOKIE, { path: '/' });
        return reply.code(204).send();
      });

      api.post(
        '/auth/mfa/enroll',
        { config: { auth: 'session-pre-mfa', routeLimit: LIMITS.mfa } },
        async (req) => {
          const me = await options.store.loadPrincipal(req.ctx.firmId, req.ctx.personId);
          return service.enrollMfa(req.ctx, me?.profile.email ?? req.ctx.personId);
        },
      );

      api.post(
        '/auth/mfa/verify',
        { config: { auth: 'session-pre-mfa', routeLimit: LIMITS.mfa } },
        async (req, reply) => {
          await service.verifyMfa(req.ctx, sessionOf(req).id, MfaCodeBody.parse(req.body).code);
          return reply.code(204).send();
        },
      );

      api.get('/me', { config: { auth: 'session-pre-mfa' } }, async (req) => {
        const { ctx } = req;
        const principal = await options.store.loadPrincipal(ctx.firmId, ctx.personId);
        if (principal === null) throw new ApiError('UNAUTHENTICATED');
        const session = sessionOf(req);
        return {
          person: {
            id: ctx.personId,
            name: principal.profile.name,
            email: principal.profile.email,
          },
          firmId: ctx.firmId,
          memberships: ctx.memberships,
          clientIds: ctx.clientIds,
          csrfToken: session.csrfToken,
          mfa: {
            required: mfaRequired(principal, ctx.memberships),
            enrolled: principal.mfaEnrolled,
            satisfied: ctx.mfaSatisfied,
          },
          asOf: ctx.asOf,
        };
      });

      api.post('/invites', { config: { auth: 'session' } }, async (req, reply) => {
        const body = InviteBody.parse(req.body);
        const { personId, email, ...grant } = body;
        const result = await service.invite(req.ctx, { personId, email, grant }, req.id);
        return reply.code(201).send(result);
      });

      api.get(
        '/invites/:token',
        { config: { auth: 'public', routeLimit: LIMITS.token } },
        async (req) => service.inviteDetails(TokenParams.parse(req.params).token),
      );

      api.post(
        '/invites/:token/accept',
        { config: { auth: 'public', routeLimit: LIMITS.token } },
        async (req, reply) => {
          const { token } = TokenParams.parse(req.params);
          const { password } = AcceptInviteBody.parse(req.body);
          const session = await service.acceptInvite(token, password, req.id);
          return { status: 'OK', ...setSessionCookie(reply, session) };
        },
      );

      api.post('/invites/:id/revoke', { config: { auth: 'session' } }, async (req, reply) => {
        await service.revokeInvite(req.ctx, IdParams.parse(req.params).id, req.id);
        return reply.code(204).send();
      });
    },
    { prefix: '/api/v1' },
  );

  return service;
}
