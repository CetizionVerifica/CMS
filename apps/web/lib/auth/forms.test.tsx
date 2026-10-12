import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { FormState } from './form-state';

const results: Record<string, FormState> = {};
vi.mock('./actions', () => {
  const make = (name: string) => async () => results[name] ?? { status: 'idle' };
  return {
    signIn: make('signIn'),
    sendMagicLink: make('sendMagicLink'),
    verifyMfa: make('verifyMfa'),
    acceptInvite: make('acceptInvite'),
    redeemMagicLink: make('redeemMagicLink'),
  };
});
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { InviteForm, LoginForm, MagicLinkForm, MfaForm } = await import('./forms');

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
});
