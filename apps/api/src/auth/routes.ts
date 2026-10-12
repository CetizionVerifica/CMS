import {
  Id,
  InviteAcceptBody,
  InviteBody,
  InviteTokenParams,
  LoginBody as ContractLoginBody,
  MagicLinkBody,
  MagicLinkVerifyBody,
  MfaVerifyBody,
} from '@canopy/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AccountStore } from './accounts.js';
import { sessionOf, SESSION_COOKIE } from './plugin.js';
import type { SecretBox } from './secretbox.js';
import { AuthService, type IssuedSession } from './service.js';

/**
 * The contract login body with what M0's next contracts release adds: an optional `firmId` for emails that sign in
 * to more than one firm, and any password length (the 12-character rule is for new passwords).
 * WIP: use `LoginBody` from contracts once that release merges.
 */
const LoginBody = ContractLoginBody.extend({
  password: z.string().min(1).max(1024),
  firmId: Id.optional(),
});
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

  /** Sets the session cookie and answers with the contract `Me`. */
  function startSession(reply: FastifyReply, session: IssuedSession) {
    reply.setCookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      expires: new Date(session.record.expiresAt),
    });
    return session.me;
  }

  void app.register(
    async (api) => {
      api.post(
        '/auth/login',
        { config: { auth: 'public', routeLimit: LIMITS.login } },
        async (req, reply) =>
          startSession(reply, await service.login(LoginBody.parse(req.body), req.id)),
      );

      api.post(
        '/auth/magic-link',
        { config: { auth: 'public', routeLimit: LIMITS.magicLink } },
        async (req, reply) => {
          await service.requestMagicLink(MagicLinkBody.parse(req.body).email, req.id);
          return reply.code(202).send();
        },
      );

      api.post(
        '/auth/magic-link/verify',
        { config: { auth: 'public', routeLimit: LIMITS.token } },
        async (req, reply) => {
          const { token } = MagicLinkVerifyBody.parse(req.body);
          return startSession(reply, await service.verifyMagicLink(token, req.id));
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
        async (req) => service.enrollMfa(req.ctx),
      );

      api.post(
        '/auth/mfa/verify',
        { config: { auth: 'session-pre-mfa', routeLimit: LIMITS.mfa } },
        async (req) =>
          service.verifyMfa(req.ctx, sessionOf(req), MfaVerifyBody.parse(req.body).code),
      );

      api.get('/me', { config: { auth: 'session-pre-mfa' } }, async (req) =>
        service.me(req.ctx, sessionOf(req)),
      );

      api.post('/invites', { config: { auth: 'session' } }, async (req, reply) => {
        const invite = await service.invite(req.ctx, InviteBody.parse(req.body), req.id);
        return reply.code(201).send(invite);
      });

      api.get(
        '/invites/:token',
        { config: { auth: 'public', routeLimit: LIMITS.token } },
        async (req) => service.invitePreview(InviteTokenParams.parse(req.params).token),
      );

      api.post(
        '/invites/:token/accept',
        { config: { auth: 'public', routeLimit: LIMITS.token } },
        async (req, reply) => {
          const { token } = InviteTokenParams.parse(req.params);
          const body = InviteAcceptBody.parse(req.body);
          return startSession(reply, await service.acceptInvite(token, body, req.id));
        },
      );

      api.post('/invites/:id/revoke', { config: { auth: 'session' } }, async (req) =>
        service.revokeInvite(req.ctx, IdParams.parse(req.params).id, req.id),
      );
    },
    { prefix: '/api/v1' },
  );

  return service;
}
