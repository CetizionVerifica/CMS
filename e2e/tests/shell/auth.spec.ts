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

  test('magic link request never reveals whether an account exists', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Email me a sign-in link instead' }).click();
    await page.getByLabel('Work email').fill('nobody@demo.test');
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
    await expect(page.getByRole('status')).toHaveText(
      'If nobody@demo.test has an account, a sign-in link is on its way.',
    );
    await checkPage(page);

    await page.goto('/login/link?token=expired');
    await checkPage(page);
    await page.getByRole('button', { name: 'Continue to sign in' }).click();
    await expect(
      page.getByText('This sign-in link has expired or was already used. Request a new one.'),
    ).toBeVisible();
  });

  test('an invite sets a password and signs the person in', async ({ page }) => {
    await page.goto('/invite/not-a-token');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('This invite isn’t valid');

    await page.goto('/invite/demo-invite');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome, Owner 02');
    await checkPage(page);
    await page.getByLabel('Work email').fill('owner02@demo.test');
    await page.getByLabel('Choose a password').fill('a-long-password');
    await page.getByLabel('Repeat the password').fill('different-password');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('The passwords do not match')).toBeVisible();
    await expect(page.getByLabel('Work email')).toHaveValue('owner02@demo.test');
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
});
