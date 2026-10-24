import { expect, test } from '@playwright/test';

import { checkPage, DEMO_METALS, MFA_CODE, PASSWORD, signIn } from './helpers.js';

test.describe('auth pages', () => {
  test('a signed-out visit goes to login and comes back to the same page', async ({ page }) => {
    await page.goto(`/c/${DEMO_METALS}/calendar?fy=2022-23&q=Q2`);
    await expect(page).toHaveURL(/\/login\?next=/);
    await expect(page).toHaveTitle('Sign in · PlanetPulse Compliance');
    await checkPage(page);

    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Enter a valid email address')).toBeVisible();
    await page.getByLabel('Work email').fill('owner@demo.test');
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'don’t match' })).toHaveText(
      'That email and password don’t match an account.',
    );
    // The email stays filled in after a failed attempt.
    await expect(page.getByLabel('Work email')).toHaveValue('owner@demo.test');

    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(`/c/${DEMO_METALS}/calendar?fy=2022-23&q=Q2`);
    await expect(page.getByRole('heading', { level: 1, name: 'Calendar' })).toBeVisible();
  });

  test('firm users verify a code before they get in', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Work email').fill('consultant@demo.test');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/login\/verify/);
    await checkPage(page);
    await page.getByLabel('6-digit code').fill('000000');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(
      page.getByText('That code isn’t right. Check your authenticator app.'),
    ).toBeVisible();
    await page.getByLabel('6-digit code').fill(MFA_CODE);
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page).toHaveURL('/portfolio');
  });

  test('pages send a content security policy their own scripts satisfy', async ({ page }) => {
    const violations: string[] = [];
    page.on('console', (m) => {
      if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
    });
    const response = await page.goto('/login');
    const policy = response!.headers()['content-security-policy'] ?? '';
    expect(policy).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain('unsafe-eval');
    // A fresh nonce per response.
    const again = (await page.request.get('/login')).headers()['content-security-policy'];
    expect(again).not.toBe(policy);
    // React hydrated under the policy: this switch is client state.
    await page.getByRole('button', { name: 'Email me a sign-in link instead' }).click();
    await expect(page.getByRole('button', { name: 'Email me a sign-in link' })).toBeVisible();
    await signIn(page, 'consultant@demo.test', '/portfolio');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(violations).toEqual([]);
  });

  test('a firm user with no authenticator sets one up, then gets in', async ({ page }) => {
    await page.goto(`/login?next=${encodeURIComponent(`/c/${DEMO_METALS}/overview`)}`);
    await page.getByLabel('Work email').fill('newconsultant@demo.test');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/login\/mfa-setup\?next=/);
    await expect(page).toHaveTitle('Set up sign-in codes · PlanetPulse Compliance');
    await checkPage(page);
    // The code step has nothing to offer without an authenticator, so it sends them back here.
    await page.goto('/login/verify');
    await expect(page).toHaveURL('/login/mfa-setup');
    await page.goBack();

    // Keyboard only: the button, then focus lands on the steps that replace it.
    await page.getByRole('button', { name: 'Get a setup key' }).focus();
    await page.keyboard.press('Enter');
    const steps = page.getByRole('heading', { name: 'Add PlanetPulse Compliance to your app' });
    await expect(steps).toBeFocused();
    await expect(page.getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'add the key in your authenticator app' }),
    ).toHaveAttribute('href', /^otpauth:\/\/totp\/PlanetPulse%20Compliance%3Anewconsultant/);
    await checkPage(page);
    await page.setViewportSize({ width: 375, height: 800 });
    await checkPage(page);

    await page.getByLabel('6-digit code').fill('000000');
    await page.getByRole('button', { name: 'Finish setup' }).click();
    await expect(
      page.getByText('That code isn’t right. Check your authenticator app.'),
    ).toBeVisible();
    await page.getByLabel('6-digit code').fill(MFA_CODE);
    await page.getByRole('button', { name: 'Finish setup' }).click();
    await expect(page).toHaveURL(`/c/${DEMO_METALS}/overview`);
  });

  test('an email in two firms picks the firm before signing in', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Work email').fill('twofirms@demo.test');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('status')).toHaveText(
      'This email signs in to more than one firm. Choose one and enter your password again.',
    );
    const firms = page.getByRole('group', { name: 'Firm' });
    await expect(firms.getByRole('radio')).toHaveCount(2);
    await checkPage(page);

    // Nothing is picked for them.
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Choose the firm to sign in to')).toBeVisible();
    await checkPage(page);

    // Keyboard only: tab into the group and pick with the arrow keys.
    await page.getByLabel('Work email').focus();
    await page.keyboard.press('Tab');
    await expect(firms.getByRole('radio', { name: 'Demo Advisory' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(firms.getByRole('radio', { name: 'Demo Partners' })).toBeChecked();
    await page.keyboard.press('Tab');
    await page.keyboard.type(PASSWORD);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/login\/verify/);
  });

  test('magic link request never reveals whether an account exists', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Email me a sign-in link instead' }).click();
    await page.getByLabel('Work email').fill('nobody@demo.test');
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
    await expect(page.getByRole('status')).toHaveText(
      'If nobody@demo.test has an account, a sign-in link is on its way.',
    );
    await checkPage(page);

    await page.goto('/login/link?token=expired-link-token-01');
    await checkPage(page);
    await page.getByRole('button', { name: 'Continue to sign in' }).click();
    await expect(
      page.getByText('This sign-in link has expired or was already used. Request a new one.'),
    ).toBeVisible();
  });

  test('an invite sets a password and signs the person in', async ({ page }) => {
    await page.goto('/invite/not-a-token');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('This invite isn’t valid');

    await page.goto('/invite/demo-invite-0001');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome, Owner 02');
    await checkPage(page);
    await expect(page.getByLabel('Work email')).toHaveValue('owner02@demo.test');
    await page.getByLabel('Your name').fill('Owner Two');
    await page.getByLabel('Choose a password').fill('a-long-password');
    await page.getByLabel('Repeat the password').fill('different-password');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('The passwords do not match')).toBeVisible();
    await expect(page.getByLabel('Your name')).toHaveValue('Owner Two');
    await page.getByLabel('Choose a password').fill('a-long-password');
    await page.getByLabel('Repeat the password').fill('a-long-password');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(`/c/${DEMO_METALS}/overview`);
  });

  test('sign out ends the session', async ({ page }) => {
    await signIn(page, 'owner@demo.test');
    await page.getByRole('button', { name: 'Account menu, Owner 01' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL('/login');
    await page.goto(`/c/${DEMO_METALS}/overview`);
    await expect(page).toHaveURL(/\/login\?next=/);
  });

  test('a support link without its token, or with a used one, never opens the account', async ({
    page,
  }) => {
    await page.goto('/support/start');
    await expect(page).toHaveTitle('PlanetPulse support · PlanetPulse Compliance');
    await expect(page.getByRole('alert').filter({ hasText: 'incomplete' })).toHaveText(
      'This support link is incomplete. Open the account again from the PlanetPulse console.',
    );
    await checkPage(page);

    // A fresh document: a hash-only change on the same page would not re-read the fragment.
    await page.goto('/login');
    await page.goto('/support/start#token=an-unknown-support-token');
    await expect(page.getByRole('alert').filter({ hasText: 'expired' })).toHaveText(
      'This support link has expired, was already used, or the account’s support access has ended. Open a new one from the console.',
    );
    // The token is wiped from the address bar once read, and no session starts.
    await expect(page).toHaveURL('/support/start');
    await checkPage(page);
    await page.goto(`/c/${DEMO_METALS}/overview`);
    await expect(page).toHaveURL(/\/login\?next=/);
  });
});
