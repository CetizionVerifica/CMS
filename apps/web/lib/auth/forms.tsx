'use client';
// Auth page forms. Each posts to a Server Action, works without JavaScript (plain form post) and shows field errors
// next to the field, plus one summary message that is announced.
import { Button, Input } from '@canopy/ui';
import NextLink from 'next/link';
import { useActionState, useState } from 'react';

import { acceptInvite, sendMagicLink, signIn, redeemMagicLink, verifyMfa } from './actions';
import { IDLE, type FormState } from './form-state';

const typed = (state: FormState, name: string) => state.values?.[name];

function fieldError(state: FormState, name: string): string | undefined {
  return state.status === 'invalid' ? state.fieldErrors[name] : undefined;
}

function FormMessage({ state }: { state: FormState }) {
  if (state.status === 'error') {
    return (
      <p role="alert" className="rounded-control bg-crit-soft px-3 py-2 text-body text-crit-ink">
        {state.message}
      </p>
    );
  }
  if (state.status === 'done') {
    return (
      <p role="status" className="rounded-control bg-ok-soft px-3 py-2 text-body text-ok-ink">
        {state.message}
      </p>
    );
  }
  if (state.status === 'invalid') {
    return (
      <p role="alert" className="sr-only">
        Check the highlighted fields.
      </p>
    );
  }
  return null;
}

export function LoginForm({ next }: { next?: string }) {
  const [mode, setMode] = useState<'password' | 'link'>('password');
  const [state, action, pending] = useActionState(signIn, IDLE);
  const [linkState, linkAction, linkPending] = useActionState(sendMagicLink, IDLE);

  if (mode === 'link') {
    return (
      <form action={linkAction} className="flex flex-col gap-3.5" noValidate>
        <FormMessage state={linkState} />
        <Input
          label="Work email"
          name="email"
          type="email"
          autoComplete="email"
          defaultValue={typed(linkState, 'email')}
          required
          error={fieldError(linkState, 'email')}
        />
        <Button type="submit" variant="primary" loading={linkPending}>
          Email me a sign-in link
        </Button>
        <button
          type="button"
          onClick={() => setMode('password')}
          className="self-center text-body font-semibold text-forest underline underline-offset-2"
        >
          Sign in with a password instead
        </button>
      </form>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-3.5" noValidate>
      <FormMessage state={state} />
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <Input
        label="Work email"
        name="email"
        type="email"
        autoComplete="username"
        defaultValue={typed(state, 'email')}
        required
        error={fieldError(state, 'email')}
      />
      <Input
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        error={fieldError(state, 'password')}
      />
      <Button type="submit" variant="primary" loading={pending}>
        Sign in
      </Button>
      <button
        type="button"
        onClick={() => setMode('link')}
        className="self-center text-body font-semibold text-forest underline underline-offset-2"
      >
        Email me a sign-in link instead
      </button>
    </form>
  );
}

export function MfaForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState(verifyMfa, IDLE);
  return (
    <form action={action} className="flex flex-col gap-3.5" noValidate>
      <FormMessage state={state} />
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <Input
        label="6-digit code"
        helper="From your authenticator app."
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={7}
        required
        error={fieldError(state, 'code')}
      />
      <Button type="submit" variant="primary" loading={pending}>
        Verify
      </Button>
    </form>
  );
}

export function InviteForm({
  token,
  email,
  displayName,
}: {
  token: string;
  email: string;
  displayName: string;
}) {
  const [state, action, pending] = useActionState(acceptInvite, IDLE);
  return (
    <form action={action} className="flex flex-col gap-3.5" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="invitedName" value={displayName} />
      <Input
        label="Work email"
        helper="You’ll sign in with this address."
        name="email"
        type="email"
        autoComplete="username"
        defaultValue={email}
        readOnly
      />
      <Input
        label="Your name"
        name="displayName"
        autoComplete="name"
        defaultValue={typed(state, 'displayName') ?? displayName}
        required
        error={fieldError(state, 'displayName')}
      />
      <Input
        label="Choose a password"
        helper="At least 12 characters."
        name="password"
        type="password"
        autoComplete="new-password"
        required
        error={fieldError(state, 'password')}
      />
      <Input
        label="Repeat the password"
        name="confirm"
        type="password"
        autoComplete="new-password"
        required
        error={fieldError(state, 'confirm')}
      />
      <Button type="submit" variant="primary" loading={pending}>
        Create account
      </Button>
      <p className="text-meta text-muted">
        Already set up?{' '}
        <NextLink href="/login" className="font-semibold text-forest underline underline-offset-2">
          Sign in
        </NextLink>
      </p>
    </form>
  );
}

/** The page an emailed link opens. Signing in needs a click, so a mail scanner that fetches the link can't use it. */
export function MagicLinkForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(redeemMagicLink, IDLE);
  return (
    <form action={action} className="flex flex-col gap-3.5">
      <FormMessage state={state} />
      <input type="hidden" name="token" value={token} />
      <Button type="submit" variant="primary" loading={pending}>
        Continue to sign in
      </Button>
      {state.status === 'error' ? (
        <NextLink
          href="/login"
          className="self-center text-body font-semibold text-forest underline underline-offset-2"
        >
          Back to sign in
        </NextLink>
      ) : null}
    </form>
  );
}
