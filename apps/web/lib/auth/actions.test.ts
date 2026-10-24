import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  nextHeaders,
  nextNavigation,
  RedirectError,
  request,
  resetRequest,
} from '../test/next-mocks';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => nextHeaders);
vi.mock('next/navigation', () => nextNavigation);

const actions = await import('./actions');
const { IDLE } = await import('./form-state');

const form = (values: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
};

async function run(p: Promise<unknown>): Promise<unknown> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof RedirectError) return { redirect: e.url };
    throw e;
  }
}

describe('auth actions', () => {
  beforeEach(() => {
    resetRequest();
    vi.unstubAllEnvs();
  });

  it('signs in and returns to a safe next path', async () => {
    const result = await run(
      actions.signIn(
        IDLE,
        form({ email: 'owner@demo.test', password: 'demo-password', next: '/c/x/register' }),
      ),
    );
    expect(result).toEqual({ redirect: '/c/x/register' });
    expect(request.cookies.get('pp_session')).toBeTruthy();
  });

  it('ignores an off-site next path', async () => {
    const result = await run(
      actions.signIn(
        IDLE,
        form({ email: 'owner@demo.test', password: 'demo-password', next: '//evil.test' }),
      ),
    );
    expect(result).toEqual({ redirect: '/' });
  });

  it('reports field errors and a wrong password without saying which was wrong', async () => {
    expect(await actions.signIn(IDLE, form({ email: 'x', password: '' }))).toMatchObject({
      status: 'invalid',
      fieldErrors: { email: 'Enter a valid email address', password: 'Enter your password' },
    });
    expect(
      await actions.signIn(IDLE, form({ email: 'owner@demo.test', password: 'wrong' })),
    ).toEqual({
      status: 'error',
      message: 'That email and password don’t match an account.',
      values: { email: 'owner@demo.test' },
    });
    // Long enough for the contract, so the API answers.
    expect(
      await actions.signIn(IDLE, form({ email: 'owner@demo.test', password: 'wrong-password-1' })),
    ).toMatchObject({
      status: 'error',
      message: 'That email and password don’t match an account.',
    });
    expect(await actions.signIn(IDLE, form({ email: 'bad', password: 'wrong' }))).toEqual({
      status: 'invalid',
      fieldErrors: { email: 'Enter a valid email address' },
      values: { email: 'bad' },
    });
  });

  it('asks which firm when the email signs in to more than one, then signs in to the chosen one', async () => {
    const email = 'twofirms@demo.test';
    const firms = [
      { id: '00000000-0000-5000-8000-0000000000f1', name: 'Demo Advisory' },
      { id: '00000000-0000-5000-8000-0000000000f2', name: 'Demo Partners' },
    ];
    const choose = await actions.signIn(IDLE, form({ email, password: 'demo-password' }));
    expect(choose).toEqual({
      status: 'choose-firm',
      message:
        'This email signs in to more than one firm. Choose one and enter your password again.',
      values: { email },
      firms,
    });
    expect(request.cookies.get('pp_session')).toBeFalsy();

    // No firm picked: the list stays and the field says what's missing.
    expect(await actions.signIn(choose, form({ email, password: 'demo-password' }))).toEqual({
      status: 'invalid',
      fieldErrors: { firmId: 'Choose the firm to sign in to' },
      values: { email },
      firms,
    });
    // A malformed id counts as none picked.
    expect(
      await actions.signIn(choose, form({ email, password: 'demo-password', firmId: 'x' })),
    ).toMatchObject({
      status: 'invalid',
      fieldErrors: { firmId: 'Choose the firm to sign in to' },
    });
    // A wrong password keeps the list too.
    expect(
      await actions.signIn(choose, form({ email, password: 'wrong', firmId: firms[1]!.id })),
    ).toEqual({
      status: 'error',
      message: 'That email and password don’t match an account.',
      values: { email },
      firms,
    });
    // The API rejects an id it didn't offer.
    expect(
      await actions.signIn(
        choose,
        form({ email, password: 'demo-password', firmId: '00000000-0000-5000-8000-0000000000f9' }),
      ),
    ).toMatchObject({ status: 'error', firms });

    expect(
      await run(
        actions.signIn(
          choose,
          form({ email, password: 'demo-password', firmId: firms[1]!.id, next: '/portfolio' }),
        ),
      ),
    ).toEqual({ redirect: '/portfolio' });
    expect(request.cookies.get('pp_session')).toBeTruthy();
  });

  it('drops the firm list when the email changes', async () => {
    const choose = await actions.signIn(
      IDLE,
      form({ email: 'twofirms@demo.test', password: 'demo-password' }),
    );
    expect(
      await run(
        actions.signIn(
          choose,
          form({
            email: 'owner@demo.test',
            password: 'demo-password',
            firmId: '00000000-0000-5000-8000-0000000000f1',
          }),
        ),
      ),
    ).toEqual({ redirect: '/' });
  });

  it('treats a FIRM_CHOICE_REQUIRED without a valid firm list as a failed sign-in', async () => {
    vi.stubEnv('CANOPY_API_URL', 'http://api.test');
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: 'FIRM_CHOICE_REQUIRED', message: 'Choose', details: { firms: [] } },
            requestId: 'r1',
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(
        await actions.signIn(IDLE, form({ email: 'a@b.test', password: 'demo-password' })),
      ).toEqual({
        status: 'error',
        message: 'We couldn’t sign you in. Try again in a moment.',
        values: { email: 'a@b.test' },
      });
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows a generic message when the API is down', async () => {
    vi.stubEnv('CANOPY_API_URL', 'http://127.0.0.1:9');
    expect(
      await actions.signIn(IDLE, form({ email: 'owner@demo.test', password: 'demo-password' })),
    ).toMatchObject({
      status: 'error',
      message: 'We couldn’t sign you in. Try again in a moment.',
    });
    expect(await actions.sendMagicLink(IDLE, form({ email: 'a@b.test' }))).toMatchObject({
      status: 'error',
    });
    expect(
      await actions.redeemMagicLink(IDLE, form({ token: 'expired-link-token-01' })),
    ).toMatchObject({
      status: 'error',
      message: 'We couldn’t sign you in. Try again in a moment.',
    });
    expect(
      await actions.acceptInvite(
        IDLE,
        form({
          token: 'demo-invite-0001',
          displayName: 'Owner 02',
          password: 'long-enough-pw',
          confirm: 'long-enough-pw',
        }),
      ),
    ).toMatchObject({
      status: 'error',
      message: 'We couldn’t set up your account. Try again in a moment.',
    });
    expect(await run(actions.signOut())).toEqual({ redirect: '/login' });
  });

  it('answers a magic-link request the same way for any address', async () => {
    expect(await actions.sendMagicLink(IDLE, form({ email: 'nobody@demo.test' }))).toEqual({
      status: 'done',
      message: 'If nobody@demo.test has an account, a sign-in link is on its way.',
      values: { email: 'nobody@demo.test' },
    });
    expect(await actions.sendMagicLink(IDLE, form({ email: 'bad' }))).toMatchObject({
      status: 'invalid',
    });
  });

  it('explains an expired magic link', async () => {
    expect(
      await actions.redeemMagicLink(IDLE, form({ token: 'expired-link-token-01' })),
    ).toMatchObject({
      status: 'error',
      message: 'This sign-in link has expired or was already used. Request a new one.',
    });
    // A token the contract rejects never reaches the API.
    expect(await actions.redeemMagicLink(IDLE, form({ token: 'short' }))).toEqual({
      status: 'error',
      message: 'This sign-in link isn’t valid.',
    });
  });

  it('verifies the MFA code', async () => {
    await run(
      actions.signIn(IDLE, form({ email: 'consultant@demo.test', password: 'demo-password' })),
    );
    expect(await actions.verifyMfa(IDLE, form({ code: '12' }))).toMatchObject({
      status: 'invalid',
    });
    expect(await actions.verifyMfa(IDLE, form({ code: '000000' }))).toEqual({
      status: 'invalid',
      fieldErrors: { code: 'That code isn’t right. Check your authenticator app.' },
    });
    expect(
      await run(actions.verifyMfa(IDLE, form({ code: '123 456', next: '/portfolio' }))),
    ).toEqual({
      redirect: '/portfolio',
    });
  });

  it('starts MFA setup and finishes it with the first code', async () => {
    await run(
      actions.signIn(IDLE, form({ email: 'newconsultant@demo.test', password: 'demo-password' })),
    );
    const started = await actions.startMfaEnrolment(IDLE, form({ next: '/portfolio' }));
    expect(started).toMatchObject({
      status: 'enrolment',
      secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    });
    expect(started.status === 'enrolment' && started.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(
      await run(actions.verifyMfa(IDLE, form({ code: '123456', next: '/portfolio' }))),
    ).toEqual({ redirect: '/portfolio' });
  });

  it('sends a firm user who already has an authenticator to the code step', async () => {
    await run(
      actions.signIn(IDLE, form({ email: 'consultant@demo.test', password: 'demo-password' })),
    );
    expect(await run(actions.startMfaEnrolment(IDLE, form({ next: '/portfolio' })))).toEqual({
      redirect: '/login/verify?next=%2Fportfolio',
    });
    expect(await run(actions.startMfaEnrolment(IDLE, form({})))).toEqual({
      redirect: '/login/verify',
    });
  });

  it('sends MFA setup without a session back to login', async () => {
    expect(await run(actions.startMfaEnrolment(IDLE, form({})))).toEqual({ redirect: '/login' });
  });

  it('sends MFA without a session back to login', async () => {
    expect(await run(actions.verifyMfa(IDLE, form({ code: '123456' })))).toEqual({
      redirect: '/login',
    });
  });

  it('accepts an invite', async () => {
    const values = {
      token: 'demo-invite-0001',
      invitedName: 'Owner 02',
      displayName: 'Owner 02',
      password: 'long-enough-pw',
      confirm: 'long-enough-pw',
    };
    expect(await actions.acceptInvite(IDLE, form({ ...values, confirm: 'x' }))).toEqual({
      status: 'invalid',
      fieldErrors: { confirm: 'The passwords do not match' },
      values: { displayName: 'Owner 02' },
    });
    expect(
      await actions.acceptInvite(
        IDLE,
        form({ ...values, displayName: ' ', password: 'short', confirm: 'short' }),
      ),
    ).toEqual({
      status: 'invalid',
      fieldErrors: { displayName: 'Enter your name', password: 'Use 12 to 200 characters' },
      values: { displayName: ' ' },
    });
    expect(await actions.acceptInvite(IDLE, form({ ...values, token: 'nope' }))).toMatchObject({
      status: 'error',
      message: 'This invite is no longer valid. Ask for a new one.',
    });
    expect(await run(actions.acceptInvite(IDLE, form(values)))).toEqual({ redirect: '/' });
    expect(
      await run(actions.acceptInvite(IDLE, form({ ...values, displayName: 'Owner Two' }))),
    ).toEqual({ redirect: '/' });
  });

  it('signs out', async () => {
    await run(actions.signIn(IDLE, form({ email: 'owner@demo.test', password: 'demo-password' })));
    expect(await run(actions.signOut())).toEqual({ redirect: '/login' });
    expect(request.cookies.has('pp_session')).toBe(false);
    expect(await run(actions.signOut())).toEqual({ redirect: '/login' });
  });
});
