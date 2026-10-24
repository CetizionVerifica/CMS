import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { apiError, fakeApi, ME } from '../test/fake-api';
import { LoginForm, nextPath } from './LoginForm';

async function signIn(code = '123456') {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Email'), 'ops@planetpulse.example');
  await user.type(screen.getByLabelText('Password'), 'operator password, long enough');
  await user.type(screen.getByLabelText('Authenticator code'), code);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('operator sign-in', () => {
  it('sends email, password and code, then goes where the operator was headed', async () => {
    const api = fakeApi({ 'POST /auth/login': { body: ME } });
    const navigate = vi.fn();
    render(<LoginForm next="/renewals" navigate={navigate} fetchImpl={api.fetch} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeTruthy();
    await signIn('123 456');
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/renewals'));
    expect(api.sent[0]!.body).toEqual({
      email: 'ops@planetpulse.example',
      password: 'operator password, long enough',
      code: '123456',
    });
  });

  it('checks the code before asking the API', async () => {
    const api = fakeApi({});
    render(<LoginForm next={null} navigate={vi.fn()} fetchImpl={api.fetch} />);
    await signIn('12');
    expect(screen.getByRole('alert').textContent).toMatch(/6-digit code/);
    expect(api.sent).toHaveLength(0);
  });

  it('says the same thing whichever part was wrong, and asks to wait when rate limited', async () => {
    let status = 401;
    const api = fakeApi({
      'POST /auth/login': () =>
        status === 401
          ? apiError(401, 'UNAUTHENTICATED', 'Email, password or code is not correct.')
          : status === 429
            ? apiError(429, 'RATE_LIMITED', 'Slow down.')
            : apiError(500, 'INTERNAL', 'Boom.'),
    });
    render(<LoginForm next={null} navigate={vi.fn()} fetchImpl={api.fetch} />);
    await signIn();
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Email, password or code is not correct.',
    );
    status = 429;
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Wait a minute/));
    status = 500;
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/could not sign you in/),
    );
  });

  it('only goes back to console paths', () => {
    expect(nextPath('/accounts/abc')).toBe('/accounts/abc');
    expect(nextPath('//evil.example')).toBe('/accounts');
    expect(nextPath('https://evil.example')).toBe('/accounts');
    expect(nextPath('/login')).toBe('/accounts');
    expect(nextPath(null)).toBe('/accounts');
  });
});
