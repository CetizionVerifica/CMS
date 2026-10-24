import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { FormState } from './form-state';

const results: Record<string, FormState> = {};
const posted: string[] = [];
vi.mock('./actions', () => {
  const make = (name: string) => async () => results[name] ?? { status: 'idle' };
  return {
    signIn: make('signIn'),
    sendMagicLink: make('sendMagicLink'),
    verifyMfa: make('verifyMfa'),
    startMfaEnrolment: make('startMfaEnrolment'),
    acceptInvite: make('acceptInvite'),
    redeemMagicLink: make('redeemMagicLink'),
    startSupportSession: async (_prev: FormState, data: FormData) => {
      posted.push(String(data.get('token')));
      return results.startSupportSession ?? { status: 'idle' };
    },
  };
});
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { InviteForm, LoginForm, MagicLinkForm, MfaForm, MfaSetupForm, SupportStartForm } =
  await import('./forms');

describe('auth forms', () => {
  it('signs in and shows field errors beside the fields', async () => {
    results.signIn = {
      status: 'invalid',
      fieldErrors: { email: 'Enter a valid email address' },
      values: { email: 'x' },
    };
    render(<LoginForm next="/portfolio" />);
    expect((document.querySelector('input[name="next"]') as HTMLInputElement).value).toBe(
      '/portfolio',
    );
    await userEvent.type(screen.getByLabelText('Work email'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter a valid email address')).toBeTruthy();
    expect(screen.getByLabelText('Work email').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Check the highlighted fields.')).toBeTruthy();
    // React resets the form after the action; the typed email comes back from the action state.
    expect((screen.getByLabelText('Work email') as HTMLInputElement).value).toBe('x');
  });

  it('offers the firms when the email signs in to more than one', async () => {
    const firms = [
      { id: 'f1', name: 'Demo Advisory' },
      { id: 'f2', name: 'Demo Partners' },
    ];
    results.signIn = {
      status: 'choose-firm',
      message: 'This email signs in to more than one firm.',
      values: { email: 'twofirms@demo.test' },
      firms,
    };
    render(<LoginForm />);
    expect(screen.queryByRole('group', { name: 'Firm' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('status')).textContent).toContain('more than one firm');
    const group = screen.getByRole('group', { name: 'Firm' });
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => [r.name, r.value, r.checked])).toEqual([
      ['firmId', 'f1', false],
      ['firmId', 'f2', false],
    ]);
    expect(group.getAttribute('aria-describedby')).toBeNull();

    results.signIn = {
      status: 'invalid',
      fieldErrors: { firmId: 'Choose the firm to sign in to' },
      values: { email: 'twofirms@demo.test' },
      firms,
    };
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const error = await screen.findByText('Choose the firm to sign in to');
    expect(screen.getByRole('group', { name: 'Firm' }).getAttribute('aria-describedby')).toBe(
      error.id,
    );
    await userEvent.click(screen.getByLabelText('Demo Partners'));
    expect((screen.getByLabelText('Demo Partners') as HTMLInputElement).checked).toBe(true);
  });

  it('switches to a magic link and confirms it was sent', async () => {
    results.sendMagicLink = {
      status: 'done',
      message: 'If a@b.test has an account, a sign-in link is on its way.',
    };
    render(<LoginForm />);
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link instead' }));
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    expect((await screen.findByRole('status')).textContent).toContain('sign-in link is on its way');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in with a password instead' }));
    expect(screen.getByLabelText('Password')).toBeTruthy();
  });

  it('announces a form-level error', async () => {
    results.verifyMfa = {
      status: 'error',
      message: 'We couldn’t check the code. Try again in a moment.',
    };
    render(<MfaForm next="/x" />);
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect((await screen.findByRole('alert')).textContent).toContain('couldn’t check the code');
  });

  it('shows the invited email read-only and prefills the name', () => {
    render(<InviteForm token="t" email="new@demo.test" displayName="Owner 02" />);
    const email = screen.getByLabelText('Work email') as HTMLInputElement;
    expect(email.value).toBe('new@demo.test');
    expect(email.readOnly).toBe(true);
    expect((screen.getByLabelText('Your name') as HTMLInputElement).value).toBe('Owner 02');
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login');
  });

  it('offers a way back when a magic link fails', async () => {
    results.redeemMagicLink = { status: 'error', message: 'This sign-in link has expired.' };
    render(<MagicLinkForm token="t" />);
    await userEvent.click(screen.getByRole('button', { name: 'Continue to sign in' }));
    expect(await screen.findByRole('link', { name: 'Back to sign in' })).toBeTruthy();
  });

  it('shows the setup key once asked, moves focus to the steps, then takes the first code', async () => {
    results.startMfaEnrolment = {
      status: 'enrolment',
      secret: 'JBSWY3DPEHPK3PXP',
      otpauthUrl: 'otpauth://totp/PlanetPulse%20Compliance%3Aa%40b.test?secret=JBSWY3DPEHPK3PXP',
    };
    render(<MfaSetupForm next="/portfolio" />);
    expect(screen.queryByLabelText('6-digit code')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Get a setup key' }));
    const heading = await screen.findByRole('heading', {
      name: 'Add PlanetPulse Compliance to your app',
    });
    // Focus moves in an effect after the heading renders, so wait for it.
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'add the key in your authenticator app' })
        .getAttribute('href'),
    ).toBe(results.startMfaEnrolment.otpauthUrl);
    expect(screen.getByLabelText('6-digit code')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Finish setup' })).toBeTruthy();
    expect((document.querySelector('input[name="next"]') as HTMLInputElement).value).toBe(
      '/portfolio',
    );
  });

  it('says so when setup could not start', async () => {
    results.startMfaEnrolment = {
      status: 'error',
      message: 'We couldn’t start the setup. Try again in a moment.',
    };
    render(<MfaSetupForm />);
    await userEvent.click(screen.getByRole('button', { name: 'Get a setup key' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'We couldn’t start the setup. Try again in a moment.',
    );
  });

  it('posts the support token from the fragment once and wipes it from the address bar', async () => {
    results.startSupportSession = {
      status: 'error',
      message: 'This support link has expired.',
    };
    window.history.replaceState(null, '', '/support/start#token=one-time-support-token-1');
    render(<SupportStartForm />);
    expect((await screen.findByRole('alert')).textContent).toContain('expired');
    expect(posted).toEqual(['one-time-support-token-1']);
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/support/start');
    expect(screen.queryByRole('button', { name: 'Open the account' })).toBeNull();
  });

  it('says so when the support link has no token', async () => {
    window.history.replaceState(null, '', '/support/start');
    render(<SupportStartForm />);
    expect((await screen.findByRole('alert')).textContent).toContain('incomplete');
  });
});
