'use server';
// Server Actions behind the auth pages and the user menu. Input is validated with the contracts' request schemas, the
// same ones the API uses (root rule 7); the API sets the session cookie and these actions relay it to the browser.
import {
  InviteAcceptBody,
  LoginBody,
  MagicLinkBody,
  MagicLinkVerifyBody,
  MfaVerifyBody,
} from '@canopy/contracts';
import { redirect } from 'next/navigation';

import { isApiError } from '../api/client';
import { relayCookies, serverApi, sessionApi } from '../api/server';
import { safeNextPath } from '../routes';
import { fieldErrors, type FormState } from './form-state';

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

export async function signIn(_prev: FormState, form: FormData): Promise<FormState> {
  const password = text(form, 'password');
  const input = LoginBody.safeParse({ email: text(form, 'email').trim(), password });
  const next = safeNextPath(text(form, 'next'));
  const values = { email: text(form, 'email') };
  if (!input.success) {
    const errors = fieldErrors(input.error, FIELD_MESSAGES);
    if (!password) errors.password = 'Enter your password';
    // A password the contract rejects can't belong to an account: say so, as for a wrong one.
    else if (errors.password && !errors.email) return wrongPassword(values);
    else delete errors.password;
    return { status: 'invalid', fieldErrors: errors, values };
  }
  try {
    const { setCookies } = await (await serverApi()).login(input.data);
    await relayCookies(setCookies);
  } catch (error) {
    if (isApiError(error, 'UNAUTHENTICATED')) return wrongPassword(values);
    if (isApiError(error, 'RATE_LIMITED')) {
      return {
        status: 'error',
        message: 'Too many attempts. Wait a few minutes and try again.',
        values,
      };
    }
    return { status: 'error', message: 'We couldn’t sign you in. Try again in a moment.', values };
  }
  // The shell checks MFA and sends firm users to the verify step.
  redirect(next ?? '/');
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
    if (isApiError(error, 'MFA_REQUIRED')) {
      return {
        status: 'invalid',
        fieldErrors: { code: 'That code isn’t right. Check your authenticator app.' },
      };
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
