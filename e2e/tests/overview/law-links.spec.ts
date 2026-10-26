import { expect, type Locator, type Page, test } from '@playwright/test';

import { checkPage, DEMO_METALS, signIn } from '../shell/helpers.js';

// Statutory numbers open the statutory list (docs/iso/packages.md ISO-12c, plan §4.6). With the ISO add-on the
// register also lists ISO activities, while the overview counts STATUTE-act instances only, so every link on the
// overview says `source=LAW` and the register it opens shows exactly the number on the card. In the demo every account
// has the add-on except the company admin's (company@demo.test). Demo Metals' ISO activities (M0's firm B fixture)
// fall due in FY 2024-25. These journeys only read.
const C = `/c/${DEMO_METALS}`;
const FY = 'fy=2024-25';
const OVERVIEW = `${C}/overview?${FY}`;

/** The number a KPI card states, from its link's name ("Overdue, 5, needs action. Open …"). */
async function cardCount(card: Locator): Promise<number> {
  const name = (await card.getAttribute('aria-label')) ?? (await card.innerText());
  const n = /^[^,]+, (\d+)[,.]/.exec(name)?.[1];
  expect(n, name).toBeDefined();
  return Number(n);
}

/** The number in the register's "38 instances match". */
async function matching(page: Page): Promise<number> {
  const text = page.getByText(/^\d+ instances? match$/);
  await expect(text).toBeVisible();
  return Number((await text.innerText()).split(' ')[0]);
}

test.describe('overview numbers with the ISO add-on at 1280px', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('each KPI count equals the rows of the Law register it opens', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', OVERVIEW);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await checkPage(page);
    const main = page.getByRole('main');

    for (const name of [/^Open, \d+\./, /^Overdue, \d+, /, /^Awaiting approval, \d+\./]) {
      const card = main.getByRole('link', { name });
      const shown = await cardCount(card);
      await expect(card).toHaveAttribute('href', /[?&]source=LAW&/);
      await card.click();
      await expect(page).toHaveURL(/[?&]source=LAW&/);
      await expect(page.getByRole('button', { name: 'Source filter: Law. Change' })).toBeVisible();
      expect(await matching(page)).toBe(shown);
      await checkPage(page);
      // Without the source the same filter also lists ISO activities, which the card does not count.
      if (name.source.startsWith('^Open')) {
        await page.goto(page.url().replace('source=LAW&', ''));
        await expect.poll(() => matching(page)).toBeGreaterThan(shown);
      }
      await page.goto(OVERVIEW);
      await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    }

    // The calendar link stays on the statutory work too.
    await expect(main.getByRole('link', { name: 'Open the calendar' })).toHaveAttribute(
      'href',
      `${C}/calendar?source=LAW&${FY}`,
    );
  });

  test('keyboard only: the Overdue card opens its Law list', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', OVERVIEW);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    const overdue = page.getByRole('main').getByRole('link', { name: /^Overdue, \d+, / });
    const shown = await cardCount(overdue);
    const label = await overdue.getAttribute('aria-label');
    // A string, because the e2e tsconfig has no DOM types.
    const focusedLabel = () =>
      page.evaluate<string | null>(`document.activeElement?.getAttribute('aria-label') ?? null`);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    for (let i = 0; i < 10 && (await focusedLabel()) !== label; i++) {
      await page.keyboard.press('Tab');
    }
    await expect(overdue).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${C}/register?status=OVERDUE&source=LAW&${FY}`);
    expect(await matching(page)).toBe(shown);
  });
});

test.describe('overview numbers without the ISO add-on', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the links carry no source, and the count still equals its list', async ({ page }) => {
    await signIn(page, 'company@demo.test', OVERVIEW);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    const main = page.getByRole('main');
    const overdue = main.getByRole('link', { name: /^Overdue, \d+, / });
    await expect(overdue).toHaveAttribute('href', `${C}/register?status=OVERDUE&${FY}`);
    await expect(main.getByRole('link', { name: 'Open the calendar' })).toHaveAttribute(
      'href',
      `${C}/calendar?${FY}`,
    );
    const shown = await cardCount(overdue);
    await overdue.click();
    expect(await matching(page)).toBe(shown);
    await checkPage(page);
  });
});

test.describe('overview numbers with the ISO add-on at 375px', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('the Open card opens its Law list on a phone', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', OVERVIEW);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await checkPage(page);
    const open = page.getByRole('main').getByRole('link', { name: /^Open, \d+\./ });
    const shown = await cardCount(open);
    await open.click();
    await expect(page).toHaveURL(/[?&]source=LAW&/);
    expect(await matching(page)).toBe(shown);
    await checkPage(page);
  });
});
