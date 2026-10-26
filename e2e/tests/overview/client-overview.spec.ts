import { expect, test } from '@playwright/test';

import { checkPage, DEMO_METALS, signIn } from '../shell/helpers.js';

// Client overview (M13) against the web app's demo API, which answers the overview and breakdowns from M0's mock
// server (apps/web/lib/api/mock-delegate.ts). M0's data sits in FY 2024-25, so the journeys select that period; the
// page sends it to the API and carries it on every link. Counts can move when the mock's "today" moves, so most
// checks read the shape and the links, not exact numbers. The demo account has the ISO add-on, so its register also
// lists ISO activities while the overview counts statutory work only: every link says `source=LAW` (ISO-12c).
const REGISTER = `/c/${DEMO_METALS}/register`;
const FY = 'fy=2024-25';
const LAW = 'source=LAW';
const OVERVIEW = `/c/${DEMO_METALS}/overview?${FY}`;

test.describe('client overview', () => {
  test('a consultant sees the numbers, and each one opens exactly those rows in the register', async ({
    page,
  }) => {
    await signIn(page, 'consultant@demo.test', OVERVIEW);
    await expect(page).toHaveURL(OVERVIEW);
    await expect(page).toHaveTitle('Overview · Demo Metals · PlanetPulse Compliance');
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await expect(page.getByText(/overdue|Nothing is due/).first()).toBeVisible();
    await checkPage(page);

    const main = page.getByRole('main');
    await expect(main.getByRole('link', { name: /^Compliance score, / })).toHaveAttribute(
      'href',
      `${REGISTER}?status=COMPLIED%2CCOMPLIED_LATE&${LAW}&${FY}`,
    );
    await expect(main.getByRole('link', { name: /^Open, \d+\./ })).toHaveAttribute(
      'href',
      `${REGISTER}?status=UPCOMING%2CDUE_SOON%2COVERDUE&${LAW}&${FY}`,
    );
    await expect(main.getByRole('link', { name: /^Overdue, \d+, / })).toHaveAttribute(
      'href',
      `${REGISTER}?status=OVERDUE&${LAW}&${FY}`,
    );
    for (const name of [
      'Readiness by department',
      'Upcoming deadlines',
      'Status by Act',
      'My open items',
    ]) {
      await expect(main.getByRole('heading', { level: 2, name })).toBeVisible();
    }

    // Every non-zero count in the department table and the Act legends is its own link, filtered to its rows.
    const departments = main.getByRole('table', { name: 'Readiness by department' });
    await expect(departments.getByRole('row')).toHaveCount(4);
    const complied = departments.getByRole('link', { name: /^\d+ complied in Finance, / });
    await expect(complied).toHaveAttribute(
      'href',
      new RegExp(
        `^${REGISTER}\\?departmentId=[0-9a-f-]+&status=COMPLIED%2CCOMPLIED_LATE&${LAW}&${FY}$`,
      ),
    );
    const acts = main.getByRole('region', { name: 'Status by Act' });
    await expect(acts.getByRole('link', { name: /^\d+ pending under / }).first()).toHaveAttribute(
      'href',
      new RegExp(
        `^${REGISTER}\\?actId=[0-9a-f-]+&status=UPCOMING%2CDUE_SOON%2CSUBMITTED&${LAW}&${FY}$`,
      ),
    );

    await main.getByRole('link', { name: /^Awaiting approval, \d+\./ }).click();
    await expect(page).toHaveURL(`${REGISTER}?status=SUBMITTED&${LAW}&${FY}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Register' })).toBeVisible();

    await page.goBack();
    await departments.getByRole('link', { name: 'Finance', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${REGISTER}\\?departmentId=[0-9a-f-]+&${LAW}&${FY}$`));
  });

  test('a quarter in the URL is kept on every register link', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', `${OVERVIEW}&q=Q2`);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await checkPage(page);
    const overdue = page.getByRole('main').getByRole('link', { name: /^Overdue, / });
    await expect(overdue).toHaveAttribute('href', `${REGISTER}?status=OVERDUE&${LAW}&${FY}&q=Q2`);
  });

  test('with no period in the URL, links carry the client’s current period', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', `/c/${DEMO_METALS}/overview`);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await checkPage(page);
    const overdue = page.getByRole('main').getByRole('link', { name: /^Overdue, / });
    await expect(overdue).toHaveAttribute(
      'href',
      /^[^?]+\?status=OVERDUE&source=LAW&fy=\d{4}-\d{2}&q=Q[1-4]$/,
    );
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
    await expect(page).toHaveURL(`${REGISTER}?status=COMPLIED%2CCOMPLIED_LATE&${LAW}&${FY}`);
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
    await expect(page.getByRole('link', { name: /^Awaiting approval, \d+\./ })).toBeVisible();
    await checkPage(page);
  });
});
