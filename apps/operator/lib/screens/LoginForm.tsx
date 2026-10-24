'use client';
// Operator sign-in: email, password and the authenticator code, every time (ADR M15-0001 decision 9). Any failure
// reads the same, so the form never says which of the three was wrong.
import { Button, Input } from '@canopy/ui';
import { useState, type FormEvent } from 'react';

import { createOperatorClient, isOperatorApiError } from '../api';
import { CONSOLE_NAME } from '../format';
import { FormError } from '../ui/parts';

/** Where to go after signing in: a console path from `?next=`, else the accounts list. */
export function nextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/login')) {
    return '/accounts';
  }
  return next;
}

export function LoginForm({
  next,
  navigate,
  fetchImpl,
}: {
  next: string | null;
  navigate: (href: string) => void;
  fetchImpl?: typeof fetch;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const code = String(data.get('code') ?? '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(code)) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await createOperatorClient({ fetch: fetchImpl }).call('operatorLogin', {
        body: {
          email: String(data.get('email') ?? '').trim(),
          password: String(data.get('password') ?? ''),
          code,
        },
      });
      navigate(nextPath(next));
    } catch (e) {
      setError(
        isOperatorApiError(e, 'RATE_LIMITED')
          ? 'Too many attempts. Wait a minute and try again.'
          : isOperatorApiError(e, 'UNAUTHENTICATED', 'VALIDATION')
            ? 'Email, password or code is not correct.'
            : 'The console could not sign you in. Try again.',
      );
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-card border border-line bg-surface p-6">
        <p className="mb-1 text-meta font-bold text-forest">{CONSOLE_NAME}</p>
        <h1 className="mb-4 text-page text-ink">Sign in</h1>
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
          <FormError message={error} />
          <Input label="Email" name="email" type="email" autoComplete="username" required />
          <Input
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          <Input
            label="Authenticator code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            helper="The 6 digits your authenticator app shows now."
            required
          />
          <Button type="submit" loading={pending} className="mt-1">
            Sign in
          </Button>
        </form>
      </div>
    </main>
  );
}
