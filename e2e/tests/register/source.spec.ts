import { devices, expect, type Page, test } from '@playwright/test';

import { checkPage, DEMO_METALS, signIn } from '../shell/helpers.js';

// The Source filter (Law, ISO) on the register, approvals, calendar and evidence vault (docs/iso/packages.md ISO-11c).
// In the demo every account has the ISO add-on except the company admin's (company@demo.test). Demo Metals' ISO
// activities (M0's firm B fixture) all fall due in FY 2024-25, two of them in November 2024. These journeys only read,
// so they run beside the register journeys; they compare numbers that those journeys don't change. The approvals
// inbox's filter needs an ISO item waiting, which only a decision makes, so its journey runs in order with the other
// approvals journeys in register.spec.ts.
const C = `/c/${DEMO_METALS}`;
const FY = 'fy=2024-25';
const NOVEMBER = `${C}/calendar?${FY}&m=2024-11`;
/** The names of Demo Metals' ISO activities' Acts (catalogue §3), as the register and approvals show them. */
const ISO_ACT = /ISO \d+|Integrated management system/;

/** The number in "38 instances match" or "15 files match". */
async function matching(page: Page, noun: 'instance' | 'file'): Promise<number> {
  const text = page.getByText(new RegExp(`^\\d+ ${noun}s? match$`));
  await expect(text).toBeVisible();
  return Number((await text.innerText()).split(' ')[0]);
}

/** The number in the calendar's "12 instances due". */
async function due(page: Page): Promise<number> {
  const text = page.getByText(/^\d+ instances? due$/);
  await expect(text).toBeVisible();
  return Number((await text.innerText()).split(' ')[0]);
}

test.describe('Source filter with the ISO add-on at 1280px', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the register narrows to the ISO activities or the statutory work, and a saved link keeps it', async ({
    page,
  }) => {
    await signIn(page, 'consultant@demo.test', `${C}/register?${FY}`);
    const all = await matching(page, 'instance');

    const filters = page.getByRole('group', { name: 'Filters' });
    await filters.getByRole('button', { name: 'Source', exact: true }).click();
    await page.getByRole('checkbox', { name: 'ISO' }).click();
    await expect(page).toHaveURL(new RegExp(`\\?${FY}&source=ISO$`));
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Source filter: ISO. Change' })).toBeVisible();
    await expect.poll(() => matching(page, 'instance')).toBeLessThan(all);
    const iso = await matching(page, 'instance');
    expect(iso).toBeGreaterThan(0);
    const acts = await page
      .getByRole('table', { name: 'Register' })
      .getByRole('row')
      .allInnerTexts();
    expect(acts.slice(1).every((row) => ISO_ACT.test(row))).toBe(true);
    await checkPage(page);

    // A link with the filter opens on it: the statutory work alone, which with the ISO activities makes the whole.
    await page.goto(`${C}/register?${FY}&source=LAW`);
    await expect(page.getByRole('button', { name: 'Source filter: Law. Change' })).toBeVisible();
    expect((await matching(page, 'instance')) + iso).toBe(all);
    await checkPage(page);
  });

  test('the calendar and the vault take the same filter, the calendar from the keyboard alone', async ({
    page,
  }) => {
    await signIn(page, 'consultant@demo.test', NOVEMBER);
    await expect(page.getByRole('heading', { level: 2, name: 'November 2024' })).toBeVisible();
    const all = await due(page);
    // After Next month the Tab order is the Source buttons (Law and ISO, Law, ISO), then the View buttons.
    const choose = async (name: 'Law' | 'ISO') => {
      await page.getByRole('button', { name: 'Next month' }).focus();
      for (let i = 0; i < (name === 'Law' ? 2 : 3); i++) await page.keyboard.press('Tab');
      await expect(
        page.getByRole('group', { name: 'Source' }).getByRole('button', { name, exact: true }),
      ).toBeFocused();
      await page.keyboard.press('Enter');
    };
    await choose('ISO');
    await expect(page).toHaveURL(`${NOVEMBER}&source=ISO`);
    await expect.poll(() => due(page)).toBeLessThan(all);
    const iso = await due(page);
    expect(iso).toBeGreaterThan(0);
    await checkPage(page);
    await choose('Law');
    await expect(page).toHaveURL(`${NOVEMBER}&source=LAW`);
    await expect.poll(() => due(page)).toBe(all - iso);
    // Moving months keeps the filter.
    await page.getByRole('button', { name: 'Next month' }).click();
    await expect(page).toHaveURL(/m=2024-12/);
    await expect(page).toHaveURL(/source=LAW/);
    await checkPage(page);

    await page.goto(`${C}/evidence`);
    const files = await matching(page, 'file');
    await page
      .getByRole('group', { name: 'Filters' })
      .getByRole('button', { name: 'Source', exact: true })
      .click();
    await page.getByRole('checkbox', { name: 'ISO' }).click();
    await expect(page).toHaveURL(`${C}/evidence?source=ISO`);
    await page.keyboard.press('Escape');
    await expect.poll(() => matching(page, 'file')).toBeLessThan(files);
    expect(await matching(page, 'file')).toBeGreaterThan(0);
    await checkPage(page);
  });
});

test.describe('without the ISO add-on', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('no page shows the filter, and a source left in a link is ignored', async ({ page }) => {
    await signIn(page, 'company@demo.test', `${C}/register?${FY}`);
    const lawOnly = await matching(page, 'instance');
    expect(lawOnly).toBeGreaterThan(0);
    await expect(
      page.getByRole('group', { name: 'Filters' }).getByRole('button', { name: /^Source/ }),
    ).toHaveCount(0);
    // No ISO rows, and `source=ISO` changes nothing: the API lists the statutory work only.
    const acts = await page
      .getByRole('table', { name: 'Register' })
      .getByRole('row')
      .allInnerTexts();
    expect(acts.slice(1).some((row) => ISO_ACT.test(row))).toBe(false);
    await page.goto(`${C}/register?${FY}&source=ISO`);
    expect(await matching(page, 'instance')).toBe(lawOnly);
    await checkPage(page);

    await page.goto(`${NOVEMBER}&source=ISO`);
    await expect(page.getByRole('heading', { level: 2, name: 'November 2024' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Source' })).toHaveCount(0);
    const ignored = await due(page);
    await page.goto(NOVEMBER);
    expect(await due(page)).toBe(ignored);
    await checkPage(page);

    await page.goto(`${C}/evidence?source=ISO`);
    await expect(
      page.getByRole('group', { name: 'Filters' }).getByRole('button', { name: /^Source/ }),
    ).toHaveCount(0);
    const vault = await matching(page, 'file');
    await page.goto(`${C}/evidence`);
    expect(await matching(page, 'file')).toBe(vault);
    await checkPage(page);
  });
});

test.describe('Source filter at 375px on a phone', () => {
  test.use({
    viewport: { width: 375, height: 740 },
    userAgent: devices['iPhone 13'].userAgent,
    hasTouch: true,
    isMobile: true,
  });

  test('the register and the vault filter from the Filters sheet', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', `${C}/register?${FY}`);
    const all = await matching(page, 'instance');
    await page.getByRole('button', { name: 'Filters' }).click();
    const sheet = page.getByRole('dialog', { name: 'Filters' });
    await sheet.getByRole('button', { name: 'Source' }).click();
    await sheet.getByRole('checkbox', { name: 'ISO' }).click();
    await expect(page).toHaveURL(new RegExp(`\\?${FY}&source=ISO$`));
    await sheet.getByRole('button', { name: /^Show / }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole('button', { name: 'Filters (1)' })).toBeVisible();
    await expect.poll(() => matching(page, 'instance')).toBeLessThan(all);
    await checkPage(page);

    await page.goto(`${C}/evidence`);
    const files = await matching(page, 'file');
    await page.getByRole('button', { name: 'Filters' }).click();
    await sheet.getByRole('button', { name: 'Source' }).click();
    await sheet.getByRole('checkbox', { name: 'ISO' }).click();
    await expect(page).toHaveURL(`${C}/evidence?source=ISO`);
    await sheet.getByRole('button', { name: /^Show / }).click();
    await expect(sheet).toBeHidden();
    await expect.poll(() => matching(page, 'file')).toBeLessThan(files);
    expect(await matching(page, 'file')).toBeGreaterThan(0);
    await checkPage(page);
  });

  test('the calendar and approvals fit the screen with the filter', async ({ page }) => {
    await signIn(page, 'approver@demo.test', `${NOVEMBER}&source=ISO`);
    await expect(
      page.getByRole('group', { name: 'Source' }).getByRole('button', { name: 'ISO', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await checkPage(page);
    await page.goto(`${C}/approvals?source=LAW`);
    await expect(
      page.getByRole('group', { name: 'Source' }).getByRole('button', { name: 'Law', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await checkPage(page);
  });
});
