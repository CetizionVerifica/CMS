import { devices, expect, test, type Page } from '@playwright/test';

import { expectNoA11yViolations } from '../../support/a11y.js';
import { checkPage, DEMO_METALS, signIn } from '../shell/helpers.js';

// The register (M12) against the web app's demo API, which hands instance routes to M0's mock server. Its Demo
// Metals rows fall in FY 2023-24, so the journeys open that year.
const REGISTER = `/c/${DEMO_METALS}/register`;
const APPROVALS = `/c/${DEMO_METALS}/approvals`;
const FY = 'fy=2023-24';

const matchCount = (page: Page) => page.getByText(/^\d+ instances? match$/);

async function count(page: Page): Promise<number> {
  return Number((await matchCount(page).innerText()).split(' ')[0]);
}

type AnimatedDocument = {
  getAnimations(): { playState: string; effect: { getTiming(): { iterations?: number } } | null }[];
};

/**
 * Waits for CSS transitions and animations to finish, so axe measures colours at rest: a row's buttons fade in and out
 * with focus, and mid-fade they fail contrast. A function, not a string: the app's Content-Security-Policy refuses
 * eval, and Playwright evaluates a string in the page. The e2e tsconfig has no DOM types, hence `AnimatedDocument`.
 */
async function settled(page: Page): Promise<void> {
  // Endless ones (a spinner) never finish, so only the ones that end are waited for.
  await page.waitForFunction(() =>
    (globalThis as unknown as { document: AnimatedDocument }).document
      .getAnimations()
      .every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
  );
}

test.describe('register', () => {
  test('a consultant filters the register, and the URL keeps the filters and the period', async ({
    page,
  }) => {
    await signIn(page, 'consultant@demo.test', `${REGISTER}?${FY}`);
    await expect(page).toHaveTitle('Register · Demo Metals · PlanetPulse Compliance');
    await expect(page.getByRole('heading', { level: 1, name: 'Register' })).toBeVisible();
    const table = page.getByRole('table', { name: 'Register' });
    await expect(table.getByRole('row').nth(1)).toBeVisible();
    await checkPage(page);
    const all = await count(page);
    expect(all).toBeGreaterThan(0);

    const filters = page.getByRole('group', { name: 'Filters' });
    await filters.getByRole('button', { name: 'Status' }).click();
    await page.getByRole('checkbox', { name: 'Complied', exact: true }).click();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page).toHaveURL(new RegExp(`${FY}&status=COMPLIED`));
    await expect(filters.getByRole('button', { name: /Status filter: Complied/ })).toBeVisible();
    await expect.poll(() => count(page)).toBeLessThan(all);
    await checkPage(page);

    // A reload shows the same rows: the state is all in the URL.
    const filtered = await count(page);
    await page.reload();
    await expect.poll(() => count(page)).toBe(filtered);

    await page.getByRole('searchbox', { name: /Search ID, title or Act/ }).fill('zzzz-nothing');
    await expect(page).toHaveURL(/search=zzzz-nothing/);
    await expect(page.getByText('No instances match these filters')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page).toHaveURL(`${REGISTER}?${FY}`);
    await expect.poll(() => count(page)).toBe(all);
  });

  test('an approver selects the waiting rows, confirms, and approves them', async ({ page }) => {
    // Every due date from April 2023, so all of the approver's waiting rows are in the view.
    await signIn(
      page,
      'approver@demo.test',
      `${REGISTER}?dueFrom=2023-04-01&workflowState=SUBMITTED`,
    );
    const table = page.getByRole('table', { name: 'Register' });
    await expect(table.getByRole('row').nth(1)).toBeVisible();
    await table.getByRole('checkbox', { name: 'Select all rows' }).check();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    const dialog = page.getByRole('alertdialog', { name: /^Approve \d+ instances?\?$/ });
    await expect(dialog).toBeVisible();
    // The dialog hides the page behind it, so axe checks it on its own rather than through checkPage.
    await expectNoA11yViolations(page);
    // Cancel approves nothing; asking again and confirming does.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await dialog.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText(/^Approved \d+ instances?\.$/)).toBeVisible();
    await expect(dialog).toBeHidden();
    await checkPage(page);
  });

  // The drawer journeys run after the bulk approve above has approved what was waiting: the owner submits one
  // instance and asks for another to be marked not applicable, and the approver then decides both.
  test('an owner opens an instance, attaches evidence and submits it', async ({ page }) => {
    await signIn(
      page,
      'owner@demo.test',
      `${REGISTER}?dueFrom=2023-04-01&ownerId=me&workflowState=OPEN`,
    );
    const link = page.getByRole('table', { name: 'Register' }).getByRole('link').first();
    await expect(link).toBeVisible();
    const title = await link.innerText();
    await link.click();
    const drawer = page.getByRole('dialog', { name: title });
    await expect(drawer.getByRole('heading', { name: 'Mark as done' })).toBeVisible();
    await expect(page).toHaveURL(/\/register\/[0-9a-f-]{36}\?dueFrom=2023-04-01&/);
    await expectNoA11yViolations(page);

    // The drawer's URL is a link to it: a reload opens the same instance.
    await page.reload();
    await expect(drawer.getByRole('heading', { name: 'Mark as done' })).toBeVisible();

    await drawer.locator('input[type=file]').setInputFiles({
      name: 'challan.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 demo challan'),
    });
    const files = drawer.getByRole('list', { name: 'Evidence files' });
    // PENDING until the virus check, then the file opens.
    await expect(files.getByRole('button', { name: 'Open challan.pdf' })).toBeVisible({
      timeout: 15_000,
    });
    await drawer.getByLabel('Completed on', { exact: true }).fill('15 Nov 2024');
    await drawer.getByLabel('Completed on', { exact: true }).press('Tab');
    await drawer.getByLabel('What was done').fill('Deposited and filed; the challan is attached.');
    await drawer.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText('Submitted for approval.').first()).toBeVisible();
    await expect(drawer.getByRole('heading', { name: 'Mark as done' })).toBeHidden();
    await expect(drawer.getByText(/submitted it/).first()).toBeVisible();
    await expectNoA11yViolations(page);

    await drawer.getByRole('button', { name: 'Close' }).click();
    await expect(drawer).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`${REGISTER}\\?dueFrom=2023-04-01&`));
    await checkPage(page);

    // Closing refreshes the view, so the submitted instance leaves this list of open work.
    await expect(link).not.toHaveText(title);
    const other = await link.innerText();
    await link.click();
    const second = page.getByRole('dialog', { name: other });
    await second.getByRole('button', { name: 'Not applicable…' }).click();
    const na = page.getByRole('alertdialog', { name: 'Ask to mark this not applicable?' });
    await na.getByLabel(/doesn’t apply/).fill('The unit has no boilers.');
    await na.getByRole('button', { name: 'Ask for not applicable' }).click();
    await expect(page.getByText('Sent to the approver as not applicable.').first()).toBeVisible();
    await expect(second.getByText('The unit has no boilers.').first()).toBeVisible();
  });

  test('an approver approves an instance from the drawer with the keyboard, then sends the next back', async ({
    page,
  }) => {
    await signIn(
      page,
      'approver@demo.test',
      `${REGISTER}?dueFrom=2023-04-01&approverId=me&workflowState=SUBMITTED`,
    );
    const link = page.getByRole('table', { name: 'Register' }).getByRole('link').first();
    await expect(link).toBeVisible();
    const title = await link.innerText();
    await link.focus();
    await page.keyboard.press('Enter');
    const drawer = page.getByRole('dialog', { name: title });
    const approve = drawer.getByRole('button', { name: /^Approve/ });
    await expect(approve).toBeVisible();
    await approve.focus();
    await page.keyboard.press('Enter');
    const confirm = page.getByRole('alertdialog', {
      name: /^Approve (this instance|as not applicable)\?$/,
    });
    await expect(confirm).toBeVisible();
    await expectNoA11yViolations(page);
    // Focus starts in the optional comment; Ctrl+Enter confirms.
    await page.keyboard.press('Control+Enter');
    await expect(page.getByText('Approved.').first()).toBeVisible();
    await expect(confirm).toBeHidden();
    await expect(approve).toBeHidden();

    // The next waiting instance, without closing the drawer.
    await drawer.getByRole('button', { name: 'Next instance' }).click();
    const next = page.getByRole('dialog');
    await expect(next).not.toHaveAccessibleName(title);
    const sendBack = next.getByRole('button', { name: 'Send back…' });
    await expect(sendBack).toBeVisible();
    await sendBack.click();
    const reason = page.getByRole('alertdialog', { name: 'Send this back to the owner?' });
    await reason.getByLabel('Reason').fill('The challan is for the wrong month.');
    await reason.getByRole('button', { name: 'Send back' }).click();
    await expect(page.getByText('Sent back to the owner.').first()).toBeVisible();
    await expect(next.getByText('The challan is for the wrong month.').first()).toBeVisible();

    // Send back is gone, so focus is back on the drawer's title rather than lost.
    await expect(next.getByRole('heading', { level: 2 })).toBeFocused();
    await next.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await checkPage(page);
  });

  test('an approver works through the approvals inbox with J, K, A and S', async ({ page }) => {
    // The drawer journeys above decided every waiting row; the owner asks for two NA decisions to work through.
    await signIn(
      page,
      'owner@demo.test',
      `${REGISTER}?dueFrom=2023-04-01&ownerId=me&workflowState=OPEN`,
    );
    const first = page.getByRole('table', { name: 'Register' }).getByRole('link').first();
    await first.click();
    for (const step of [0, 1]) {
      const drawer = page.getByRole('dialog');
      await drawer.getByRole('button', { name: 'Not applicable…' }).click();
      const na = page.getByRole('alertdialog', { name: 'Ask to mark this not applicable?' });
      await na.getByLabel(/doesn’t apply/).fill('The unit has no boilers.');
      await na.getByRole('button', { name: 'Ask for not applicable' }).click();
      await expect(na).toBeHidden();
      if (step === 0) await drawer.getByRole('button', { name: 'Next instance' }).click();
    }
    await page.context().clearCookies();

    await signIn(page, 'approver@demo.test', APPROVALS);
    await expect(page).toHaveTitle('Approvals · Demo Metals · PlanetPulse Compliance');
    await expect(page.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /^2 items waiting for your approval here/ }),
    ).toBeVisible();
    const list = page.getByRole('list', { name: 'Waiting for approval' });
    const rows = list.getByRole('link');
    await expect(rows).toHaveCount(2);
    await expect(list).toContainText('asks to mark not applicable');
    await checkPage(page);

    // Enter opens the drawer over the inbox; closing comes back to it.
    const title = (await rows.first().getAttribute('aria-label'))!.split(', due ')[0]!;
    await rows.first().focus();
    await page.keyboard.press('Enter');
    const drawer = page.getByRole('dialog', { name: title });
    await expect(drawer.getByRole('button', { name: 'Approve as not applicable' })).toBeVisible();
    await expect(page).toHaveURL(/\/approvals\/[0-9a-f-]{36}$/);
    await settled(page);
    await expectNoA11yViolations(page);
    await drawer.getByRole('button', { name: 'Close' }).click();
    await expect(drawer).toBeHidden();
    await expect(page).toHaveURL(APPROVALS);

    // J and K move; A approves the focused row and focus moves to the next one.
    await rows.first().focus();
    await page.keyboard.press('j');
    await expect(rows.nth(1)).toBeFocused();
    await page.keyboard.press('k');
    await expect(rows.first()).toBeFocused();
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await settled(page);
    await expectNoA11yViolations(page);
    await page.keyboard.press('Escape');
    await rows.first().focus();
    await page.keyboard.press('a');
    await expect(page.getByText(`Approved “${title}” as not applicable.`).first()).toBeVisible();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toBeFocused();

    // S asks for a reason, then the inbox is empty.
    await page.keyboard.press('s');
    const reason = page.getByRole('alertdialog', { name: /^Send back to / });
    await expect(reason.getByLabel(/Reason/)).toBeFocused();
    await settled(page);
    await expectNoA11yViolations(page);
    await page.keyboard.type('The unit does have a boiler.');
    await page.keyboard.press('Control+Enter');
    await expect(page.getByText(/^Sent “.+” back to /).first()).toBeVisible();
    await expect(page.getByText('Nothing waiting for your approval.')).toBeVisible();
    await checkPage(page);
  });

  test('an owner can’t open approvals', async ({ page }) => {
    await signIn(page, 'owner@demo.test', APPROVALS);
    await expect(page.getByText('You don’t have access to approvals')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Waiting for approval' })).toHaveCount(0);
    await checkPage(page);
  });

  test('an owner sees their rows with no approve or export', async ({ page }) => {
    await signIn(page, 'owner@demo.test', `${REGISTER}?${FY}`);
    const table = page.getByRole('table', { name: 'Register' });
    await expect(table.getByRole('row').nth(1)).toBeVisible();
    await expect(table.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Export' })).toHaveCount(0);
    await checkPage(page);
  });

  test('the period picker narrows the register to a quarter', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', `${REGISTER}?${FY}`);
    await expect(
      page.getByRole('table', { name: 'Register' }).getByRole('row').nth(1),
    ).toBeVisible();
    const year = await count(page);
    await page.goto(`${REGISTER}?${FY}&q=Q1`);
    await expect.poll(() => count(page)).toBeLessThan(year);
    const dates = await page
      .getByRole('table', { name: 'Register' })
      .getByRole('cell')
      .filter({ hasText: /^\d{1,2} [A-Z][a-z]{2} \d{4}$/ })
      .allInnerTexts();
    // Q1 of FY 2023-24 is April to June 2023.
    for (const date of dates) expect(date).toMatch(/ (Apr|May|Jun) 2023$/);
    await checkPage(page);
  });

  test('a saved view brings back its filters and density', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', `${REGISTER}?${FY}&status=COMPLIED`);
    await page.getByRole('button', { name: 'Compact rows' }).click();
    await page.getByRole('button', { name: /^View: / }).click();
    await page.getByRole('menuitem', { name: 'Save current view…' }).click();
    await page.getByRole('textbox', { name: /View name/ }).fill('Complied, compact');
    await page.getByRole('button', { name: 'Save view' }).click();
    await expect(page.getByRole('button', { name: 'View: Complied, compact' })).toBeVisible();

    await page.goto(`${REGISTER}?${FY}`);
    await page.getByRole('button', { name: /^View: / }).click();
    await page.getByRole('menuitemradio', { name: 'Complied, compact' }).click();
    await expect(page).toHaveURL(/status=COMPLIED/);
    await expect(page.getByRole('button', { name: 'Comfortable rows' })).toBeVisible();
    await checkPage(page);
  });
});

test.describe('register at 375px on a phone', () => {
  test.use({
    viewport: { width: 375, height: 740 },
    userAgent: devices['iPhone 13'].userAgent,
    hasTouch: true,
    isMobile: true,
  });

  test('fits the screen and still filters', async ({ page }) => {
    await signIn(page, 'approver@demo.test', `${REGISTER}?${FY}`);
    await expect(
      page.getByRole('table', { name: 'Register' }).getByRole('row').nth(1),
    ).toBeVisible();
    await checkPage(page);
    await page.getByRole('button', { name: 'Filters' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('opens an instance full screen with a way back', async ({ page }) => {
    await signIn(page, 'approver@demo.test', `${REGISTER}?${FY}`);
    const link = page.getByRole('table', { name: 'Register' }).getByRole('link').first();
    await expect(link).toBeVisible();
    await link.click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('heading', { name: 'Description' })).toBeVisible();
    await expectNoA11yViolations(page);
    const overflow = await page.evaluate<number>(
      'document.documentElement.scrollWidth - window.innerWidth',
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await drawer.getByRole('button', { name: 'Back to the register' }).click();
    await expect(drawer).toBeHidden();
    await expect(page).toHaveURL(`${REGISTER}?${FY}`);
  });

  test('shows the approvals inbox', async ({ page }) => {
    await signIn(page, 'approver@demo.test', APPROVALS);
    await expect(page.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible();
    await settled(page);
    await checkPage(page);
  });
});
