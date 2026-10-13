import { expect, test } from '@playwright/test';

import { checkPage, DEMO_METALS, signIn } from '../shell/helpers.js';

// Client overview (M13) against the web app's demo API, which answers the overview and breakdowns from M0's mock
// server (apps/web/lib/api/mock-delegate.ts). For a consultant, Demo Metals has 30 open, none overdue and 2 awaiting
// approval, across Finance, Human Resources and Safety.
const OVERVIEW = `/c/${DEMO_METALS}/overview`;

test.describe('client overview', () => {
  test('a consultant sees the numbers, and each one opens exactly those rows in the register', async ({
    page,
  }) => {
    await signIn(page, 'consultant@demo.test', OVERVIEW);
    await expect(page).toHaveURL(OVERVIEW);
    await expect(page).toHaveTitle('Overview · Demo Metals · PlanetPulse Compliance');
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await expect(
      page.getByText('Nothing is overdue. 2 items are awaiting approval.'),
    ).toBeVisible();
    await checkPage(page);

    const main = page.getByRole('main');
    await expect(main.getByRole('link', { name: /^Compliance score, / })).toBeVisible();
    await expect(main.getByRole('link', { name: /^Open, 30\./ })).toHaveAttribute(
      'href',
      `/c/${DEMO_METALS}/register?status=UPCOMING%2CDUE_SOON%2COVERDUE`,
    );
    await expect(main.getByRole('link', { name: /^Overdue, 0, / })).toHaveAttribute(
      'href',
      `/c/${DEMO_METALS}/register?status=OVERDUE`,
    );
    for (const name of [
      'Readiness by department',
      'Upcoming deadlines',
      'Status by Act',
      'My open items',
    ]) {
      await expect(main.getByRole('heading', { level: 2, name })).toBeVisible();
    }
    const departments = main.getByRole('table', { name: 'Readiness by department' });
    await expect(departments.getByRole('row')).toHaveCount(4);

    await main.getByRole('link', { name: /^Awaiting approval, 2\./ }).click();
    await expect(page).toHaveURL(`/c/${DEMO_METALS}/register?status=SUBMITTED`);
    await expect(page.getByRole('heading', { level: 1, name: 'Register' })).toBeVisible();

    await page.goBack();
    await departments.getByRole('link', { name: 'Finance', exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(`/c/${DEMO_METALS}/register\\?departmentId=[0-9a-f-]+$`),
    );
  });

  test('the period in the URL is kept on every register link', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', `${OVERVIEW}?fy=2022-23&q=Q3`);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await checkPage(page);
    const overdue = page.getByRole('main').getByRole('link', { name: /^Overdue, / });
    await expect(overdue).toHaveAttribute('href', /[?&]status=OVERDUE(&|$)/);
    await expect(overdue).toHaveAttribute('href', /[?&]fy=2022-23(&|$)/);
    await expect(overdue).toHaveAttribute('href', /[?&]q=Q3(&|$)/);
  });

  test('keyboard only: the skip link lands in main and the first Tab reaches the score card', async ({
    page,
  }) => {
    await signIn(page, 'approver@demo.test', OVERVIEW);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('main#main')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: /^Compliance score, / })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/c/${DEMO_METALS}/register\\?status=COMPLIED`));
  });

  test('an owner sees their own open items', async ({ page }) => {
    await signIn(page, 'owner@demo.test', OVERVIEW);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'My open items' })).toBeVisible();
    await checkPage(page);
  });
});

test.describe('client overview at 375px', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('every card fits the screen', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', OVERVIEW);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Awaiting approval, 2\./ })).toBeVisible();
    await checkPage(page);
  });
});
