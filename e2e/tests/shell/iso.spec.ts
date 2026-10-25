import { devices, expect, type Page, test } from '@playwright/test';

import { checkPage, DEMO_METALS, signIn } from './helpers.js';

// The ISO add-on in the shell (docs/iso/plan.md §5 and §6). In the demo every account has it except the company
// admin's (company@demo.test), so both states can be tried.
const ISO_ITEMS = [
  'ISO overview',
  'Checklist',
  'Documents',
  'Risks',
  'Objectives',
  'Audits',
  'Nonconformities',
  'Management reviews',
  'Certification',
];
const OFF = 'ISO management systems is not turned on for your account';

async function expectTurnedOff(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: OFF })).toBeVisible();
  await expect(page).toHaveTitle('Not turned on · Demo Metals · PlanetPulse Compliance');
  // Nothing of the add-on's own: no ISO group, no page header, no table.
  await expect(page.getByRole('link', { name: 'Nonconformities' })).toHaveCount(0);
  await expect(page.getByRole('table')).toHaveCount(0);
  await checkPage(page);
}

test.describe('ISO add-on in the shell at 1280px', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('an account with the add-on gets the ISO group, and every item opens', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', `/c/${DEMO_METALS}/overview`);
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByText('ISO', { exact: true })).toBeVisible();
    for (const label of ISO_ITEMS) {
      await nav.getByRole('link', { name: label, exact: true }).click();
      await expect(nav.getByRole('link', { name: label, exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(page.getByRole('heading', { level: 1, name: label })).toBeVisible();
      await expect(page).toHaveTitle(`${label} · Demo Metals · PlanetPulse Compliance`);
    }
    await checkPage(page);
  });

  test('an account without it has no ISO group, and a direct ISO URL says it is off', async ({
    page,
  }) => {
    await signIn(page, 'company@demo.test');
    await expect(page).toHaveURL(`/c/${DEMO_METALS}/overview`);
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Register', exact: true })).toBeVisible();
    await expect(nav.getByText('ISO', { exact: true })).toHaveCount(0);
    for (const label of ISO_ITEMS)
      await expect(nav.getByRole('link', { name: label })).toHaveCount(0);

    // A listed page, a record under one, and paths M17 hasn't named: all say the same, so the URL reveals nothing.
    for (const path of [
      'iso/audits',
      'iso/nonconformities/00000000-0000-5000-8000-00000000abcd',
      'iso',
      'iso/x',
    ]) {
      await page.goto(`/c/${DEMO_METALS}/${path}`);
      await expectTurnedOff(page);
    }
  });

  test('the off page works from the keyboard alone', async ({ page }) => {
    await signIn(page, 'company@demo.test', `/c/${DEMO_METALS}/iso/risks`);
    await expect(page.getByRole('heading', { name: OFF })).toBeVisible();
    const home = page.getByRole('link', { name: 'Go to home' });
    // A string, because the e2e tsconfig has no DOM types.
    const focused = () => page.evaluate<string>('document.activeElement?.textContent ?? ""');
    for (let i = 0; i < 40 && (await focused()).trim() !== 'Go to home'; i++) {
      await page.keyboard.press('Tab');
    }
    await expect(home).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`/c/${DEMO_METALS}/overview`);
  });
});

test.describe('ISO add-on in the shell at 375px on a phone', () => {
  test.use({
    viewport: { width: 375, height: 740 },
    userAgent: devices['iPhone 13'].userAgent,
    hasTouch: true,
    isMobile: true,
  });

  test('the menu sheet lists the ISO group, and the off page fits the screen', async ({ page }) => {
    await signIn(page, 'owner@demo.test');
    await page.getByRole('button', { name: 'Open menu' }).click();
    const sheet = page.getByRole('dialog', { name: 'Menu' });
    await sheet.getByRole('link', { name: 'Audits', exact: true }).click();
    await expect(page).toHaveURL(`/c/${DEMO_METALS}/iso/audits`);
    await checkPage(page);

    await page.context().clearCookies();
    await signIn(page, 'company@demo.test', `/c/${DEMO_METALS}/iso/audits`);
    await expectTurnedOff(page);
  });
});
