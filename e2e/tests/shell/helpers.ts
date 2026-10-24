import { expect, type Page } from '@playwright/test';

import { expectNoA11yViolations } from '../../support/a11y.js';

// Fixture ids and accounts from the web app's in-process mock API (apps/web/lib/api/mock.ts).
export const DEMO_METALS = '00000000-0000-5000-8000-000000000101';
export const NORTHWIND = '00000000-0000-5000-8000-000000000102';
export const PASSWORD = 'demo-password';
export const MFA_CODE = '123456';

export async function signIn(page: Page, email: string, path = '/'): Promise<void> {
  await page.goto(path);
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (['consultant@demo.test', 'admin@demo.test', 'company@demo.test'].includes(email)) {
    await expect(page).toHaveURL(/\/login\/verify/);
    await page.getByLabel('6-digit code').fill(MFA_CODE);
    await page.getByRole('button', { name: 'Verify' }).click();
  }
  await expect(page).not.toHaveURL(/\/login/);
}

/** Every page a journey visits: axe clean, the client-facing name only, no sideways page scroll. */
export async function checkPage(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expectNoA11yViolations(page);
  const text = (await page.locator('body').innerText()) + (await page.title());
  expect(text).not.toMatch(/canopy/i);
  // A string, because the e2e tsconfig has no DOM types.
  const overflow = await page.evaluate<number>(
    'document.documentElement.scrollWidth - window.innerWidth',
  );
  expect(overflow).toBeLessThanOrEqual(0);
}
