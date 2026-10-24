import { PLATFORM_ENDPOINTS, type OperatorMe } from '@canopy/contracts';
import { operatorAudit, operators, operatorSessions } from '@canopy/db';
import type { FastifyInstance } from 'fastify';
import {
  ApiError,
  hashToken,
  LOCKOUT,
  newToken,
  verifyAgainstDummy,
  verifyPassword,
  verifyTotp,
} from '../auth/index.js';
import { mountPlatform, signedInOf, type PlatformDeps, type SignedIn } from './db-http.js';
import {
  idleExpiry,
  LOGIN_LIMIT,
  OPERATOR_COOKIE,
  OPERATOR_COOKIE_PATH,
  sessionExpiry,
} from './session.js';

const WRONG = 'Email, password or code is not correct.';

function meOf({ operator, session }: SignedIn): OperatorMe {
  return {
    operator,
    csrfToken: session.csrfToken,
    session: { expiresAt: session.expiresAt, idleExpiresAt: idleExpiry(session) },
  };
}

type Outcome = { ok: true; token: string; signedIn: SignedIn } | { ok: false };

/**
 * Operator sign-in, sign-out and `/me` (ADR M15-0001 decision 9). Sign-in needs the email, the password and a TOTP
 * code together, every time, and says only "not correct" whichever was wrong, for an unknown email (checked against a
 * dummy hash, so it takes as long), a locked or disabled operator, or a code used before. Each wrong password or code
 * counts towards M5's lockout. A sign-in writes `OPERATOR_LOGIN` to the operator audit, with the address.
 */
export function registerOperatorAuth(api: FastifyInstance, deps: PlatformDeps): void {
  mountPlatform(
    api,
    deps,
    PLATFORM_ENDPOINTS.operatorLogin,
    async ({ body, now, request, reply, requestId }) => {
      const at = now.toISOString();
      const outcome = await deps.db.withOperator(requestId, async (tx): Promise<Outcome> => {
        const login = await operators.findForLogin(tx, body.email);
        if (!login) {
          await verifyAgainstDummy(body.password);
          return { ok: false };
        }
        const id = login.operator.id;
        const locked = login.lockedUntil !== null && Date.parse(login.lockedUntil) > now.getTime();
        const password = await verifyPassword(body.password, login.passwordHash);
        const step = password
          ? verifyTotp(deps.secrets.open(login.mfaSealedSecret), body.code, now)
          : null;
        if (locked) return { ok: false };
        if (step === null || !(await operators.acceptMfaStep(tx, id, step))) {
          await operators.recordFailure(tx, id, at, LOCKOUT);
          return { ok: false };
        }
        if (login.operator.disabledAt !== null) return { ok: false };
        await operators.resetFailures(tx, id);
        const token = newToken();
        const session = await operatorSessions.create(tx, {
          operatorId: id,
          tokenHash: hashToken(token),
          csrfToken: newToken(),
          expiresAt: sessionExpiry(now),
          ip: request.ip,
          createdAt: at,
        });
        await operatorAudit.append(tx, {
          operatorId: id,
          action: 'OPERATOR_LOGIN',
          accountId: null,
          before: null,
          after: null,
          reason: null,
          requestId,
          ip: request.ip,
        });
        return { ok: true, token, signedIn: { operator: login.operator, session } };
      });
      if (!outcome.ok) throw new ApiError('UNAUTHENTICATED', undefined, WRONG);
      reply.setCookie(OPERATOR_COOKIE, outcome.token, {
        httpOnly: true,
        secure: deps.secure,
        sameSite: 'strict',
        path: OPERATOR_COOKIE_PATH,
        expires: new Date(outcome.signedIn.session.expiresAt),
      });
      return meOf(outcome.signedIn);
    },
    { routeLimit: LOGIN_LIMIT },
  );

  mountPlatform(
    api,
    deps,
    PLATFORM_ENDPOINTS.operatorLogout,
    async ({ request, reply, now, requestId }) => {
      const { session } = signedInOf(request);
      await deps.db.withOperator(requestId, (tx) =>
        operatorSessions.revoke(tx, session.id, now.toISOString()),
      );
      reply.clearCookie(OPERATOR_COOKIE, { path: OPERATOR_COOKIE_PATH });
      return undefined;
    },
  );

  mountPlatform(api, deps, PLATFORM_ENDPOINTS.operatorMe, async ({ request }) =>
    meOf(signedInOf(request)),
  );
}
