'use server';
// Server Actions behind the auth pages and the user menu. Input is validated with the contracts' request schemas, the
// same ones the API uses (root rule 7); the API sets the session cookie and these actions relay it to the browser.
import {
  ERROR_DETAILS,
  InviteAcceptBody,
  LoginBody,
  MagicLinkBody,
  MagicLinkVerifyBody,
  MfaVerifyBody,
  SupportSessionVerifyBody,
} from '@canopy/contracts';
import { redirect } from 'next/navigation';

import { isApiError } from '../api/client';
import { relayCookies, serverApi, sessionApi } from '../api/server';
import { safeNextPath } from '../routes';
import { fieldErrors, type FirmChoice, type FormState } from './form-state';

const text = (form: FormData, name: string) => String(form.get(name) ?? '');

/** What the form says for a field the contract schema rejects; the schema's own messages are for developers. */
const FIELD_MESSAGES: Record<string, string> = {
  email: 'Enter a valid email address',
  // The policy for a password being set (accepting an invite). Sign-in never shows it: any password it rejects
  // can't belong to an account, so signIn answers as for a wrong one.
  password: 'Use 12 to 200 characters',
  code: 'Enter the 6-digit code',
  displayName: 'Enter your name',
};

export async function signIn(prev: FormState, form: FormData): Promise<FormState> {
  const password = text(form, 'password');
  const email = text(form, 'email');
  const next = safeNextPath(text(form, 'next'));
  // The firm list from an earlier attempt stays while the email does; another email may belong to other firms.
  const firms = prev.firms && prev.values?.email === email ? prev.firms : undefined;
  const firmId = firms ? text(form, 'firmId') : '';
  const values = { email };
  const keep = (state: FormState): FormState => (firms ? { ...state, firms } : state);
  const input = LoginBody.safeParse({
    email: email.trim(),
    password,
    ...(firmId ? { firmId } : {}),
  });
  if (!input.success || (firms && !firmId)) {
    const errors = input.success ? {} : fieldErrors(input.error, FIELD_MESSAGES);
    if (!password) errors.password = 'Enter your password';
    // A password the contract rejects can't belong to an account: say so, as for a wrong one.
    else if (errors.password && !errors.email) return keep(wrongPassword(values));
    else delete errors.password;
    // Only the options sent with the form are offered, so a missing or malformed id means none was picked.
    if (firms && (!firmId || errors.firmId)) errors.firmId = 'Choose the firm to sign in to';
    return keep({ status: 'invalid', fieldErrors: errors, values });
  }
  try {
    const { setCookies } = await (await serverApi()).login(input.data);
    await relayCookies(setCookies);
  } catch (error) {
    if (isApiError(error, 'FIRM_CHOICE_REQUIRED')) {
      const choice = firmChoice(error.details);
      if (choice) {
        return {
          status: 'choose-firm',
          message:
            'This email signs in to more than one firm. Choose one and enter your password again.',
          values,
          firms: choice,
        };
      }
    }
    if (isApiError(error, 'UNAUTHENTICATED')) return keep(wrongPassword(values));
    if (isApiError(error, 'RATE_LIMITED')) {
      return keep({
        status: 'error',
        message: 'Too many attempts. Wait a few minutes and try again.',
        values,
      });
    }
    return keep({
      status: 'error',
      message: 'We couldn’t sign you in. Try again in a moment.',
      values,
    });
  }
  // The shell checks MFA and sends firm users to the verify step.
  redirect(next ?? '/');
}

/** The firms a FIRM_CHOICE_REQUIRED error lists, or undefined when its details don't match the contract. */
function firmChoice(details: unknown): FirmChoice[] | undefined {
  const parsed = ERROR_DETAILS.FIRM_CHOICE_REQUIRED.safeParse(details);
  return parsed.success ? parsed.data.firms : undefined;
}

function wrongPassword(values: Record<string, string>): FormState {
  return { status: 'error', message: 'That email and password don’t match an account.', values };
}

export async function sendMagicLink(_prev: FormState, form: FormData): Promise<FormState> {
  const input = MagicLinkBody.safeParse({ email: text(form, 'email').trim() });
  const values = { email: text(form, 'email') };
  if (!input.success) {
    return { status: 'invalid', fieldErrors: fieldErrors(input.error, FIELD_MESSAGES), values };
  }
  try {
    await (await serverApi()).requestMagicLink(input.data.email);
  } catch (error) {
    if (isApiError(error, 'RATE_LIMITED')) {
      return {
        status: 'error',
        message: 'Too many requests. Wait a few minutes and try again.',
        values,
      };
    }
    return {
      status: 'error',
      message: 'We couldn’t send the link. Try again in a moment.',
      values,
    };
  }
  // Same answer whether or not the address has an account (no account enumeration).
  return {
    status: 'done',
    message: `If ${input.data.email} has an account, a sign-in link is on its way.`,
    values,
  };
}

export async function redeemMagicLink(_prev: FormState, form: FormData): Promise<FormState> {
  const input = MagicLinkVerifyBody.safeParse({ token: text(form, 'token') });
  if (!input.success) return { status: 'error', message: 'This sign-in link isn’t valid.' };
  try {
    const { setCookies } = await (await serverApi()).verifyMagicLink(input.data.token);
    await relayCookies(setCookies);
  } catch (error) {
    if (isApiError(error, 'UNAUTHENTICATED', 'NOT_FOUND')) {
      return {
        status: 'error',
        message: 'This sign-in link has expired or was already used. Request a new one.',
      };
    }
    return { status: 'error', message: 'We couldn’t sign you in. Try again in a moment.' };
  }
  redirect('/');
}

/**
 * Opens a PlanetPulse support session from the one-time token the operator console put in the link's fragment. The
 * token works once, within a minute, and only while the account's support grant is live (ADR M15-0001 decision 11).
 */
export async function startSupportSession(_prev: FormState, form: FormData): Promise<FormState> {
  const input = SupportSessionVerifyBody.safeParse({ token: text(form, 'token') });
  if (!input.success) return { status: 'error', message: 'This support link isn’t valid.' };
  try {
    const { setCookies } = await (await serverApi()).verifySupportSession(input.data.token);
    await relayCookies(setCookies);
  } catch (error) {
    if (isApiError(error, 'UNAUTHENTICATED', 'NOT_FOUND', 'ACCESS_EXPIRED')) {
      return {
        status: 'error',
        message:
          'This support link has expired, was already used, or the account’s support access has ended. Open a new one from the console.',
      };
    }
    if (isApiError(error, 'ACCOUNT_SUSPENDED')) {
      return { status: 'error', message: 'This account is paused, so support can’t open it.' };
    }
    return { status: 'error', message: 'We couldn’t open the account. Try again in a moment.' };
  }
  redirect('/');
}

/**
 * Starts MFA setup for a firm user who has no authenticator yet. The API makes a new secret each time, until the first
 * code completes setup, so it runs only when the person asks for a key, never on page load.
 */
export async function startMfaEnrolment(_prev: FormState, form: FormData): Promise<FormState> {
  const next = safeNextPath(text(form, 'next'));
  let otpauthUrl: string;
  try {
    ({ otpauthUrl } = (await (await sessionApi()).enrollMfa()).data);
  } catch (error) {
    // Already set up (another tab finished it): the code step is what's left.
    if (isApiError(error, 'DUPLICATE')) {
      redirect(`/login/verify${next ? `?next=${encodeURIComponent(next)}` : ''}`);
    }
    if (isApiError(error, 'UNAUTHENTICATED')) redirect('/login');
    if (isApiError(error, 'RATE_LIMITED')) {
      return { status: 'error', message: 'Too many attempts. Wait a few minutes and try again.' };
    }
    return { status: 'error', message: 'We couldn’t start the setup. Try again in a moment.' };
  }
  const secret = new URL(otpauthUrl).searchParams.get('secret');
  if (!secret) {
    return { status: 'error', message: 'We couldn’t start the setup. Try again in a moment.' };
  }
  return { status: 'enrolment', secret, otpauthUrl };
}

export async function verifyMfa(_prev: FormState, form: FormData): Promise<FormState> {
  const input = MfaVerifyBody.safeParse({ code: text(form, 'code').replace(/\s/g, '') });
  const next = safeNextPath(text(form, 'next'));
  if (!input.success) {
    return { status: 'invalid', fieldErrors: fieldErrors(input.error, FIELD_MESSAGES) };
  }
  try {
    const { setCookies } = await (await sessionApi()).verifyMfa(input.data.code);
    await relayCookies(setCookies);
  } catch (error) {
    // The API answers a wrong code with VALIDATION on `code`, and MFA_REQUIRED when there is no secret to check.
    if (isApiError(error, 'VALIDATION', 'MFA_REQUIRED')) {
      return {
        status: 'invalid',
        fieldErrors: { code: 'That code isn’t right. Check your authenticator app.' },
      };
    }
    if (isApiError(error, 'RATE_LIMITED')) {
      return { status: 'error', message: 'Too many attempts. Wait a few minutes and try again.' };
    }
    if (isApiError(error, 'UNAUTHENTICATED')) redirect('/login');
    return { status: 'error', message: 'We couldn’t check the code. Try again in a moment.' };
  }
  redirect(next ?? '/');
}

export async function acceptInvite(_prev: FormState, form: FormData): Promise<FormState> {
  const token = text(form, 'token');
  const name = text(form, 'displayName').trim();
  const values = { displayName: text(form, 'displayName') };
  const input = InviteAcceptBody.safeParse({
    password: text(form, 'password'),
    // Sent only when the person corrected the name the invite gave them.
    ...(name && name !== text(form, 'invitedName') ? { displayName: name } : {}),
  });
  const errors = input.success ? {} : fieldErrors(input.error, FIELD_MESSAGES);
  if (!name) errors.displayName = FIELD_MESSAGES.displayName!;
  // The repeat field is a typing check in the form only; the API never sees it.
  if (text(form, 'confirm') !== text(form, 'password')) {
    errors.confirm ??= 'The passwords do not match';
  }
  if (!input.success || Object.keys(errors).length > 0) {
    return { status: 'invalid', fieldErrors: errors, values };
  }
  try {
    const { setCookies } = await (await serverApi()).acceptInvite(token, input.data);
    await relayCookies(setCookies);
  } catch (error) {
    if (isApiError(error, 'NOT_FOUND', 'INVALID_TRANSITION')) {
      return {
        status: 'error',
        message: 'This invite is no longer valid. Ask for a new one.',
        values,
      };
    }
    if (isApiError(error, 'VALIDATION')) {
      return { status: 'error', message: 'Check the details and try again.', values };
    }
    return {
      status: 'error',
      message: 'We couldn’t set up your account. Try again in a moment.',
      values,
    };
  }
  redirect('/');
}

export async function signOut(): Promise<void> {
  try {
    const { setCookies } = await (await sessionApi()).logout();
    await relayCookies(setCookies);
  } catch (error) {
    // Already signed out is fine; anything else still ends at the login page.
    if (!isApiError(error, 'UNAUTHENTICATED'))
      console.error('Sign out failed', (error as Error).name);
  }
  redirect('/login');
}
