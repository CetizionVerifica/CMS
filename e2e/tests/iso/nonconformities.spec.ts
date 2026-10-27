import { devices, expect, type Locator, type Page, test } from '@playwright/test';

import { expectNoA11yViolations } from '../../support/a11y.js';
import { checkPage, DEMO_METALS, signIn } from '../shell/helpers.js';

// ISO screens part 3a (M17, docs/iso/packages.md ISO-6c) against the web app's demo API: a nonconformity raised, worked
// by its owner and twice found not effective by its approver; an incident verified effective and closed; the overview's
// nonconformity and incident counts opening exactly their records; and the NC log download.
const ISO = `/c/${DEMO_METALS}/iso`;
const OFF = 'ISO management systems is not turned on for your account';
const FILES = 'https://files.mock.invalid/**';
// The demo API's today is its data's (15 Nov 2024); the forms' is the browser's. A check date far ahead suits both.
const CHECK = '31 Dec 2030';

/** checkPage once the title is back: a server action's refresh briefly leaves the document without one. */
async function settled(page: Page): Promise<void> {
  await expect(page).toHaveTitle(/PlanetPulse Compliance$/);
  await checkPage(page);
}

/** The same with a drawer open: the page behind it, its heading included, is hidden from assistive tech. */
async function settledOpen(page: Page): Promise<void> {
  await expect(page).toHaveTitle(/PlanetPulse Compliance$/);
  await expectNoA11yViolations(page);
}

/** Picks an option of a design-system select. */
async function choose(page: Page, scope: Locator, label: string, option: string): Promise<void> {
  await scope.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

/** Types a date and leaves the field, which is when a DateInput takes it. */
async function date(scope: Locator, label: string, value: string): Promise<void> {
  const input = scope.getByRole('textbox', { name: label, exact: true });
  await input.fill(value);
  await input.press('Tab');
}

async function switchUser(page: Page, email: string, path: string): Promise<void> {
  await page.context().clearCookies();
  await signIn(page, email, path);
}

/** The number a list's filter bar says it shows. */
async function shown(page: Page, noun: RegExp): Promise<string> {
  const status = page.getByRole('status').filter({ hasText: noun });
  await expect(status).toBeVisible();
  return (await status.innerText()).trim().split(' ')[0]!;
}

/** The state the record's page shows. */
function standing(page: Page): Locator {
  return page.getByRole('region', { name: 'Where it stands' });
}

/** The owner adds a corrective action and marks it done. */
async function correctiveAction(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: 'Add corrective action' }).click();
  const add = page.getByRole('dialog', { name: 'Add corrective action' });
  await add.getByRole('textbox', { name: 'What is to be done' }).fill(text);
  await date(add, 'Due on', '31 Dec 2030');
  await add.getByRole('button', { name: 'Add corrective action' }).click();
  const item = page.getByRole('listitem', { name: `Corrective action: ${text}` });
  await expect(item.getByText('Open', { exact: true })).toBeVisible();
  await settled(page);
}

async function markDone(page: Page, text: string): Promise<void> {
  const item = page.getByRole('listitem', { name: `Corrective action: ${text}` });
  await item.getByRole('button', { name: 'Mark done' }).click();
  const done = page.getByRole('dialog', { name: 'Mark the action done' });
  await date(done, 'Done on', '14 Nov 2024');
  await done.getByRole('button', { name: 'Mark done' }).click();
  await expect(item.getByRole('button', { name: 'Mark done' })).toHaveCount(0);
  await expect(item.getByText('Done', { exact: true }).first()).toBeVisible();
}

async function planActions(page: Page): Promise<void> {
  await standing(page).getByRole('button', { name: 'Mark actions planned' }).click();
  const plan = page.getByRole('dialog', { name: 'Mark actions planned' });
  await date(plan, 'Effectiveness check due on', CHECK);
  await settledOpen(page);
  await plan.getByRole('button', { name: 'Mark actions planned' }).click();
  await expect(standing(page).getByText('Actions planned', { exact: true })).toBeVisible();
}

async function submit(page: Page): Promise<void> {
  await standing(page).getByRole('button', { name: 'Submit for verification' }).click();
  const send = page.getByRole('dialog', { name: 'Submit for verification' });
  const review = send.getByRole('textbox', { name: 'Risk review' });
  if ((await review.inputValue()) === '') await review.fill('None needed.');
  const change = send.getByRole('textbox', { name: 'Change to the system' });
  if ((await change.inputValue()) === '')
    await change.fill('Oven check added to the start-up list.');
  await send.getByRole('button', { name: 'Submit for verification' }).click();
  await expect(standing(page).getByText('Awaiting verification', { exact: true })).toBeVisible();
  await settled(page);
}

test.describe('ISO screens part 3a at 1280px', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('a nonconformity is raised, worked, and found not effective back to its root cause, then its actions', async ({
    page,
  }) => {
    const what = `Underbaked tray found at packing ${Date.now().toString(36)}`;
    await signIn(page, 'consultant@demo.test', `${ISO}/nonconformities`);
    await expect(page.getByRole('heading', { level: 1, name: 'Nonconformities' })).toBeVisible();
    await expect(page).toHaveTitle('Nonconformities · Demo Metals · PlanetPulse Compliance');
    await settled(page);

    await page.getByRole('button', { name: 'Raise a nonconformity' }).click();
    const raise = page.getByRole('dialog', { name: 'Raise a nonconformity' });
    await choose(page, raise, 'Where it came from', 'Process');
    await raise.getByRole('radio', { name: 'Minor' }).check();
    await raise.getByRole('checkbox', { name: /^ISO 9001/ }).check();
    await choose(page, raise, 'Unit (optional)', 'Pune Plant');
    await raise.getByRole('textbox', { name: 'What happened or was found' }).fill(what);
    await choose(page, raise, 'Owner', 'Rohan Joshi');
    await choose(page, raise, 'Approver', 'Nisha Patil');
    await date(raise, 'Due on', '31 Dec 2030');
    await settledOpen(page);
    await raise.getByRole('button', { name: 'Raise', exact: true }).click();

    await expect(page.getByRole('heading', { level: 1, name: what })).toBeVisible();
    await expect(page).toHaveTitle(/^Nonconformity \d+ · Demo Metals · PlanetPulse Compliance$/);
    const ncPath = new URL(page.url()).pathname;
    await expect(standing(page).getByText('Open', { exact: true })).toBeVisible();
    // The consultant raises and reassigns; the owner works it.
    await expect(standing(page).getByRole('button', { name: 'Record root cause' })).toHaveCount(0);
    await settled(page);

    await switchUser(page, 'owner@demo.test', ncPath);
    await standing(page).getByRole('button', { name: 'Record root cause' }).click();
    const cause = page.getByRole('dialog', { name: 'Record root cause' });
    await cause.getByRole('textbox', { name: 'Containment' }).fill('Held the shift’s trays.');
    await cause.getByRole('textbox', { name: 'Correction' }).fill('Rebaked the held trays.');
    await choose(page, cause, 'Root cause method', 'Five whys');
    await cause.getByRole('textbox', { name: 'Root cause' }).fill('Oven thermostat drifted.');
    await cause
      .getByRole('textbox', { name: 'Similar occurrences' })
      .fill('The second oven has the same thermostat.');
    await settledOpen(page);
    await cause.getByRole('button', { name: 'Record root cause' }).click();
    await expect(standing(page).getByText('Root cause found', { exact: true })).toBeVisible();
    await expect(page.getByText('Oven thermostat drifted.')).toBeVisible();

    // Planning needs an open corrective action.
    await correctiveAction(page, 'Recalibrate the oven thermostat.');
    await planActions(page);
    await markDone(page, 'Recalibrate the oven thermostat.');
    await submit(page);

    await switchUser(page, 'approver@demo.test', ncPath);
    // The check date is ahead, so it can only be sent back.
    await expect(standing(page).getByRole('button', { name: 'Verify effective' })).toHaveCount(0);
    await standing(page).getByRole('button', { name: 'Not effective' }).click();
    const back = page.getByRole('dialog', { name: 'Not effective' });
    await back.getByRole('radio', { name: 'Back to the root cause: it was wrong' }).check();
    await back
      .getByRole('textbox', { name: 'Why' })
      .fill('Trays still underbaked after recalibration.');
    await settledOpen(page);
    await back.getByRole('button', { name: 'Not effective' }).click();
    await expect(standing(page).getByText('Open', { exact: true })).toBeVisible();
    await expect(page.getByText(/^Effectiveness check due/)).toHaveCount(0);
    await settled(page);

    await switchUser(page, 'owner@demo.test', ncPath);
    await standing(page).getByRole('button', { name: 'Record root cause' }).click();
    const again = page.getByRole('dialog', { name: 'Record root cause' });
    await again.getByRole('textbox', { name: 'Root cause', exact: true }).fill('Door seal worn.');
    await again.getByRole('button', { name: 'Record root cause' }).click();
    await expect(standing(page).getByText('Root cause found', { exact: true })).toBeVisible();
    await correctiveAction(page, 'Replace the oven door seal.');
    await planActions(page);
    await markDone(page, 'Replace the oven door seal.');
    await submit(page);

    await switchUser(page, 'approver@demo.test', ncPath);
    // Not before the check date.
    await expect(standing(page).getByRole('button', { name: 'Verify effective' })).toHaveCount(0);
    await standing(page).getByRole('button', { name: 'Not effective' }).click();
    const later = page.getByRole('dialog', { name: 'Not effective' });
    await later.getByRole('radio', { name: /^Back to the actions: the root cause stands/ }).check();
    await date(later, 'New effectiveness check due on', '31 Dec 2031');
    await later.getByRole('textbox', { name: 'Why' }).fill('One more batch to test.');
    await settledOpen(page);
    await later.getByRole('button', { name: 'Not effective' }).click();
    await expect(standing(page).getByText('Actions planned', { exact: true })).toBeVisible();
    await expect(standing(page).getByText('Effectiveness check due 31 Dec 2031.')).toBeVisible();
    await settled(page);

    // The log lists it with its owner and approver.
    await page.goto(`${ISO}/nonconformities?state=ACTIONS_PLANNED`);
    const row = page
      .getByRole('table', { name: 'Nonconformity log' })
      .getByRole('row', { name: what });
    await expect(row.getByText('Rohan Joshi')).toBeVisible();
    await expect(row.getByText('Nisha Patil')).toBeVisible();
    await settled(page);
  });

  test('an approver verifies an incident effective once its check is due, and it closes', async ({
    page,
  }) => {
    await signIn(
      page,
      'approver@demo.test',
      `${ISO}/nonconformities?state=AWAITING_VERIFICATION&source=INCIDENT&approverId=me`,
    );
    await page.getByRole('table', { name: 'Nonconformity log' }).getByRole('link').first().click();
    await expect(page.getByRole('heading', { name: 'The incident' })).toBeVisible();
    await expect(
      standing(page).getByText(/^Effectiveness check due .*, overdue \d+ days?\.$/),
    ).toBeVisible();
    await standing(page).getByRole('button', { name: 'Verify effective' }).click();
    const verify = page.getByRole('dialog', { name: 'Verify effective' });
    await verify
      .getByRole('textbox', { name: 'How it was checked' })
      .fill('A month with no repeat.');
    await settledOpen(page);
    await verify.getByRole('button', { name: 'Verify and close' }).click();
    await expect(standing(page).getByText('Closed', { exact: true })).toBeVisible();
    await expect(standing(page).getByText('closed 15 Nov 2024')).toBeVisible();
    await expect(standing(page).getByRole('button')).toHaveCount(0);
    await settled(page);
  });

  test('each overview nonconformity and incident count opens a log showing that many records', async ({
    page,
  }) => {
    await signIn(page, 'consultant@demo.test', `${ISO}/overview`);
    await expect(page.getByRole('heading', { level: 1, name: 'ISO overview' })).toBeVisible();
    const regions = ['Nonconformities', 'Incidents this year'];
    const names: [string, string][] = [];
    for (const region of regions) {
      for (const link of await page.getByRole('region', { name: region }).getByRole('link').all()) {
        names.push([region, (await link.getAttribute('aria-label'))!]);
      }
    }
    // Open, overdue and awaiting verification are counted in the demo data, and so are incidents.
    expect(names.length).toBeGreaterThan(4);
    let fromIds = 0;
    for (const [region, name] of names) {
      await page.goto(`${ISO}/overview`);
      const link = page
        .getByRole('region', { name: region })
        .getByRole('link', { name, exact: true });
      const counted = (await link.innerText()).trim();
      await link.click();
      await expect(page).toHaveURL(/\/iso\/nonconformities\?/);
      expect(await shown(page, /records?$/), `${region}: ${name}`).toBe(counted);
      if (new URL(page.url()).searchParams.has('ids')) {
        fromIds++;
        await expect(page.getByText('Showing the records the ISO overview counted.')).toBeVisible();
      }
    }
    expect(fromIds).toBeGreaterThan(0);
    await settled(page);
  });

  test('the NC log downloads with its filters, without the overview selection', async ({
    page,
  }) => {
    let downloaded = '';
    await page.route(FILES, async (route) => {
      downloaded = route.request().url();
      await route.fulfill({
        status: 200,
        headers: { 'content-disposition': 'attachment; filename="nc-log.xlsx"' },
        body: 'log',
      });
    });
    await signIn(page, 'consultant@demo.test', `${ISO}/overview`);
    await page
      .getByRole('region', { name: 'Incidents this year' })
      .getByRole('link', { name: /all incidents/ })
      .click();
    await expect(page).toHaveURL(/\/iso\/nonconformities\?/);
    await expect(
      page.getByText('Exports the log with these filters, without the overview’s selection.'),
    ).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download NC log (Excel)' }).click();
    await download;
    expect(downloaded).toMatch(/^https:\/\/files\.mock\.invalid\/exports\//);
    await expect(
      page.getByRole('status').filter({ hasText: 'The download has started.' }),
    ).toBeVisible();
    await settled(page);

    await page.getByRole('link', { name: 'Show the whole log' }).click();
    await expect(page).toHaveURL(new RegExp(`${ISO}/nonconformities$`));
    await settled(page);
  });

  test('an incident page shows its incident, and opens from the log by keyboard alone', async ({
    page,
  }) => {
    await signIn(page, 'consultant@demo.test', `${ISO}/nonconformities?source=INCIDENT`);
    const first = page.getByRole('table', { name: 'Nonconformity log' }).getByRole('link').first();
    await expect(first).toBeVisible();
    const name = (await first.innerText()).trim();
    const focused = () => page.evaluate<string>('document.activeElement?.textContent ?? ""');
    for (let i = 0; i < 80 && (await focused()).trim() !== name; i++)
      await page.keyboard.press('Tab');
    await expect(first).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'The incident' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Corrective actions' })).toBeVisible();
    await settled(page);
  });

  test('every ISO-6c page says the add-on is off without it', async ({ page }) => {
    await signIn(page, 'company@demo.test', `${ISO}/overview`);
    for (const path of [
      'nonconformities',
      'nonconformities/00000000-0000-5000-8000-00000000abcd',
    ]) {
      await page.goto(`${ISO}/${path}`);
      await expect(page.getByRole('heading', { name: OFF })).toBeVisible();
      await expect(page).toHaveTitle('Not turned on · Demo Metals · PlanetPulse Compliance');
      await expect(page.getByRole('table')).toHaveCount(0);
      await checkPage(page);
    }
  });
});

test.describe('ISO screens part 3a at 375px on a phone', () => {
  test.use({
    viewport: { width: 375, height: 740 },
    userAgent: devices['iPhone 13'].userAgent,
    hasTouch: true,
    isMobile: true,
  });

  test('the log and a record fit the screen, and the raise form opens full screen', async ({
    page,
  }) => {
    await signIn(page, 'consultant@demo.test', `${ISO}/nonconformities`);
    await expect(page.getByRole('heading', { level: 1, name: 'Nonconformities' })).toBeVisible();
    await settled(page);
    await page.getByRole('button', { name: 'Raise a nonconformity' }).click();
    await expect(page.getByRole('dialog', { name: 'Raise a nonconformity' })).toBeVisible();
    await settledOpen(page);
    await page.keyboard.press('Escape');
    await page.getByRole('table', { name: 'Nonconformity log' }).getByRole('link').first().click();
    await expect(page.getByRole('heading', { name: 'Where it stands' })).toBeVisible();
    await settled(page);
  });
});
