'use server';
// Server Actions behind the auth pages and the user menu. Input is validated with the same Zod schemas the API uses
// (root rule 7); the API sets the session cookie and these actions relay it to the browser.
import { redirect } from 'next/navigation';

import { isApiError } from '../api/client';
import { relayCookies, serverApi, sessionApi } from '../api/server';
import {
  AcceptInviteRequest,
  LoginRequest,
  MagicLinkRequest,
  MfaVerifyRequest,
} from '../api/types';
import { safeNextPath } from '../routes';
import { fieldErrors, type FormState } from './form-state';

const text = (form: FormData, name: string) => String(form.get(name) ?? '');

export async function signIn(_prev: FormState, form: FormData): Promise<FormState> {
  const input = LoginRequest.safeParse({
    email: form.get('email'),
    password: form.get('password'),
  });
  const next = safeNextPath(text(form, 'next'));
  const values = { email: text(form, 'email') };
  if (!input.success) return { status: 'invalid', fieldErrors: fieldErrors(input.error), values };
  try {
    const { setCookies } = await (await serverApi()).login(input.data);
    await relayCookies(setCookies);
  } catch (error) {
    if (isApiError(error, 'UNAUTHENTICATED')) {
      return {
        status: 'error',
        message: 'That email and password don’t match an account.',
        values,
      };
    }
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

export async function sendMagicLink(_prev: FormState, form: FormData): Promise<FormState> {
  const input = MagicLinkRequest.safeParse({ email: form.get('email') });
  const values = { email: text(form, 'email') };
  if (!input.success) return { status: 'invalid', fieldErrors: fieldErrors(input.error), values };
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
  const token = text(form, 'token');
  if (!token || token.length > 500)
    return { status: 'error', message: 'This sign-in link isn’t valid.' };
  try {
    const { setCookies } = await (await serverApi()).verifyMagicLink(token);
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
  const input = MfaVerifyRequest.safeParse({
    code: text(form, 'code').replace(/\s/g, ''),
  });
  const next = safeNextPath(text(form, 'next'));
  if (!input.success) return { status: 'invalid', fieldErrors: fieldErrors(input.error) };
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
  const input = AcceptInviteRequest.safeParse({
    email: form.get('email'),
    password: form.get('password'),
    confirm: form.get('confirm'),
  });
  const values = { email: text(form, 'email') };
  if (!input.success) return { status: 'invalid', fieldErrors: fieldErrors(input.error), values };
  try {
    const { setCookies } = await (
      await serverApi()
    ).acceptInvite(token, {
      email: input.data.email,
      password: input.data.password,
    });
    await relayCookies(setCookies);
  } catch (error) {
    if (isApiError(error, 'NOT_FOUND')) {
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
