'use client';
// Auth page forms. Each posts to a Server Action, works without JavaScript (plain form post) and shows field errors
// next to the field, plus one summary message that is announced.
import { Button, Input } from '@canopy/ui';
import { AlertCircle } from 'lucide-react';
import NextLink from 'next/link';
import { useActionState, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

import {
  acceptInvite,
  sendMagicLink,
  signIn,
  redeemMagicLink,
  startInviteMfaEnrolment,
  startMfaEnrolment,
  startSupportSession,
  verifyMfa,
} from './actions';
import { IDLE, type FirmChoice, type FormState } from './form-state';

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
  if (state.status === 'choose-firm') {
    return (
      <p role="status" className="rounded-control bg-mist px-3 py-2 text-body text-ink">
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
      {state.firms ? (
        <FirmChoiceField firms={state.firms} error={fieldError(state, 'firmId')} />
      ) : null}
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

/**
 * The firms an email signs in to, as native radios so the form still posts without JavaScript. Nothing is picked
 * first: signing in to the wrong firm by default would be easy to miss.
 */
function FirmChoiceField({ firms, error }: { firms: FirmChoice[]; error?: string }) {
  const errorId = 'firm-choice-error';
  return (
    <fieldset className="flex flex-col gap-1" {...(error ? { 'aria-describedby': errorId } : {})}>
      <legend className="mb-1 text-meta text-ink">Firm</legend>
      {firms.map((firm) => (
        <label
          key={firm.id}
          className="flex min-h-control cursor-pointer items-center gap-2 text-body text-ink pointer-coarse:min-h-control-touch"
        >
          <input
            type="radio"
            name="firmId"
            value={firm.id}
            required
            className="size-4 accent-forest"
          />
          {firm.name}
        </label>
      ))}
      {error ? (
        <p id={errorId} className="flex items-center gap-1 text-meta text-crit-ink">
          <AlertCircle aria-hidden size={16} className="shrink-0" />
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

export function MfaForm({ next, submitLabel = 'Verify' }: { next?: string; submitLabel?: string }) {
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
        {submitLabel}
      </Button>
    </form>
  );
}

/** "JBSWY3DPEHPK3PXP" as "JBSW Y3DP EHPK 3PXP", the way authenticator apps show keys. */
const groupKey = (secret: string) => secret.match(/.{1,4}/g)?.join(' ') ?? secret;

/**
 * MFA setup for a firm user with no authenticator: asks the API for a secret, shows it as a setup key and an
 * authenticator link, then takes the first code, which completes setup and this sign-in.
 */
export function MfaSetupForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState(startMfaEnrolment, IDLE);
  const heading = useRef<HTMLHeadingElement>(null);
  const started = state.status === 'enrolment';
  // The button that started setup is gone, so focus moves to the steps that replaced it.
  useEffect(() => {
    if (started) heading.current?.focus();
  }, [started]);

  if (state.status === 'enrolment') {
    return (
      <MfaKeySteps
        heading={heading}
        secret={state.secret}
        otpauthUrl={state.otpauthUrl}
        last="Type the 6-digit code the app shows below."
      >
        <MfaForm next={next} submitLabel="Finish setup" />
      </MfaKeySteps>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-3.5" noValidate>
      <FormMessage state={state} />
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <Button type="submit" variant="primary" loading={pending}>
        Get a setup key
      </Button>
    </form>
  );
}

/** The setup key and the steps to add it, shown once MFA setup has started. */
function MfaKeySteps({
  heading,
  secret,
  otpauthUrl,
  last,
  children,
}: {
  heading: RefObject<HTMLHeadingElement | null>;
  secret: string;
  otpauthUrl: string;
  last: string;
  children?: ReactNode;
}) {
  return (
    <section aria-labelledby="mfa-steps" className="flex flex-col gap-3.5">
      <h2 id="mfa-steps" ref={heading} tabIndex={-1} className="text-card text-ink outline-none">
        Add PlanetPulse Compliance to your app
      </h2>
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-body text-ink">
        <li>
          In your authenticator app, add an account and choose to enter a setup key. Use a
          time-based key.
        </li>
        <li>
          Enter this key:
          <code className="mt-1 block rounded-control bg-mist px-3 py-2 font-mono text-body break-all text-ink select-all">
            {groupKey(secret)}
          </code>
        </li>
        <li>{last}</li>
      </ol>
      <p className="text-meta text-muted">
        On a phone with the app installed you can{' '}
        <a href={otpauthUrl} className="font-semibold text-forest underline underline-offset-2">
          add the key in your authenticator app
        </a>{' '}
        instead.
      </p>
      {children}
    </section>
  );
}

/**
 * MFA setup on the invite page for a firm role (docs/security/review.md F14): the key is added before the account
 * exists, and its first code goes with the password, so the account never exists without MFA.
 */
function InviteMfaSetup({ token }: { token: string }) {
  const [state, action, pending] = useActionState(startInviteMfaEnrolment, IDLE);
  const heading = useRef<HTMLHeadingElement>(null);
  const started = state.status === 'enrolment';
  useEffect(() => {
    if (started) heading.current?.focus();
  }, [started]);

  if (state.status === 'enrolment') {
    return (
      <MfaKeySteps
        heading={heading}
        secret={state.secret}
        otpauthUrl={state.otpauthUrl}
        last="Type the 6-digit code the app shows in the form below."
      />
    );
  }
  return (
    <form action={action} className="flex flex-col gap-3.5" noValidate>
      <p className="text-body text-ink">
        Your role signs in with a code from an authenticator app as well as your password. Set it up
        now.
      </p>
      <FormMessage state={state} />
      <input type="hidden" name="token" value={token} />
      <Button type="submit" loading={pending}>
        Get a setup key
      </Button>
    </form>
  );
}

export function InviteForm({
  token,
  email,
  displayName,
  mfaRequired = false,
}: {
  token: string;
  email: string;
  displayName: string;
  /** A firm role: set up the authenticator app first, and send its code with the password. */
  mfaRequired?: boolean;
}) {
  const [state, action, pending] = useActionState(acceptInvite, IDLE);
  return (
    <div className="flex flex-col gap-6">
      {mfaRequired ? <InviteMfaSetup token={token} /> : null}
      <form action={action} className="flex flex-col gap-3.5" noValidate>
        <FormMessage state={state} />
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="invitedName" value={displayName} />
        <input type="hidden" name="mfaRequired" value={String(mfaRequired)} />
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
        {mfaRequired ? (
          <Input
            label="6-digit code"
            helper="From your authenticator app, once you’ve added the setup key."
            name="mfaCode"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            required
            error={fieldError(state, 'mfaCode')}
          />
        ) : null}
        <Button type="submit" variant="primary" loading={pending}>
          Create account
        </Button>
        <p className="text-meta text-muted">
          Already set up?{' '}
          <NextLink
            href="/login"
            className="font-semibold text-forest underline underline-offset-2"
          >
            Sign in
          </NextLink>
        </p>
      </form>
    </div>
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

/**
 * Opens a support session from `#token=…`. The token rides in the fragment so no server or proxy logs it; it is read
 * once, wiped from the address bar and history, then posted. Without JavaScript nothing can read the fragment, so the
 * page says so.
 */
export function SupportStartForm() {
  const [state, action, pending] = useActionState(startSupportSession, IDLE);
  const [token, setToken] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  const read = useRef(false);

  useEffect(() => {
    // Once only: the fragment is gone after the first read (React may run this effect twice in development).
    if (read.current) return;
    read.current = true;
    const found = new URLSearchParams(window.location.hash.slice(1)).get('token');
    window.history.replaceState(null, '', window.location.pathname);
    if (found) setToken(found);
    else setMissing(true);
  }, []);

  useEffect(() => {
    if (token) form.current?.requestSubmit();
  }, [token]);

  if (missing) {
    return (
      <p role="alert" className="text-body text-muted">
        This support link is incomplete. Open the account again from the PlanetPulse console.
      </p>
    );
  }
  return (
    <form ref={form} action={action} className="flex flex-col gap-3.5">
      <FormMessage state={state} />
      <input type="hidden" name="token" value={token ?? ''} />
      {state.status === 'error' ? null : (
        <Button type="submit" variant="primary" loading={pending || token === null}>
          Open the account
        </Button>
      )}
      <noscript>
        <p className="text-body text-muted">Support sessions need JavaScript to open.</p>
      </noscript>
    </form>
  );
}
