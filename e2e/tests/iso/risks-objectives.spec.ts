import { devices, expect, type Locator, type Page, test } from '@playwright/test';

import { expectNoA11yViolations } from '../../support/a11y.js';
import { checkPage, DEMO_METALS, signIn } from '../shell/helpers.js';

// ISO screens part 2 (M17, docs/iso/packages.md ISO-6b) against the web app's demo API: the risk register with a hazard,
// its controls and a treatment action completed into a control; an objective's reading; the actions list; the register
// download; and the overview's counts opening exactly their records.
const ISO = `/c/${DEMO_METALS}/iso`;
const OFF = 'ISO management systems is not turned on for your account';
const FILES = 'https://files.mock.invalid/**';

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
  const input = scope.getByRole('textbox', { name: label });
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

test.describe('ISO screens part 2 at 1280px', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("a hazard gets a control and a treatment action, and its owner's completing it puts the control in place", async ({
    page,
  }) => {
    const activity = `Cleaning mixer ${Date.now().toString(36)}`;
    await signIn(page, 'consultant@demo.test', `${ISO}/risks?kind=HAZARD`);
    await expect(page.getByRole('heading', { level: 1, name: 'Risks' })).toBeVisible();
    await expect(page).toHaveTitle('Risks · Demo Metals · PlanetPulse Compliance');
    await expect(
      page.getByRole('navigation', { name: 'Kinds' }).getByRole('link', { name: 'Hazards' }),
    ).toHaveAttribute('aria-current', 'page');
    await settled(page);

    await page.getByRole('button', { name: 'Add to the register' }).click();
    const add = page.getByRole('dialog', { name: 'Add to the risk register' });
    await add.getByRole('textbox', { name: 'Activity, product or service' }).fill(activity);
    await add.getByRole('textbox', { name: 'The hazard' }).fill('Moving blades while cleaning.');
    await add.getByRole('textbox', { name: 'Harm it can cause' }).fill('Cuts to hands.');
    await add.getByRole('radio', { name: 'Non-routine' }).check();
    await add.getByRole('checkbox', { name: 'Worker' }).check();
    await choose(page, add, 'Operating condition', 'Normal');
    await choose(page, add, 'Likelihood', '3');
    await choose(page, add, 'Severity', '4');
    await choose(page, add, 'Owner', 'Rohan Joshi');
    await settledOpen(page);
    await add.getByRole('button', { name: 'Add', exact: true }).click();

    await expect(
      page.getByRole('heading', { level: 1, name: 'Moving blades while cleaning.' }),
    ).toBeVisible();
    await expect(page).toHaveTitle(`Hazard: ${activity} · Demo Metals · PlanetPulse Compliance`);
    const riskPath = new URL(page.url()).pathname;
    await expect(page.getByText('12 (3 × 4)')).toBeVisible();
    await settled(page);

    await page.getByRole('button', { name: 'Add control' }).click();
    const control = page.getByRole('dialog', { name: 'Add control in place' });
    await control.getByRole('textbox', { name: 'The control' }).fill('Cut-resistant gloves.');
    await choose(page, control, 'Kind of control', 'PPE');
    await control.getByRole('button', { name: 'Add control' }).click();
    await expect(
      page.getByRole('listitem', { name: 'Control: Cut-resistant gloves.' }).getByText('PPE'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Add treatment action' }).click();
    const plan = page.getByRole('dialog', { name: 'Add treatment action' });
    await plan.getByRole('textbox', { name: 'What is to be done' }).fill('Fit a blade guard.');
    await choose(page, plan, 'Kind of control', 'Engineering');
    await choose(page, plan, 'Owner', 'Rohan Joshi');
    await date(plan, 'Due on', '31 Dec 2030');
    await plan.getByRole('button', { name: 'Add treatment action' }).click();
    const action = page.getByRole('listitem', { name: 'Treatment action: Fit a blade guard.' });
    await expect(action.getByText('Open', { exact: true })).toBeVisible();
    // A consultant plans the work; its owner marks it done.
    await expect(action.getByRole('button', { name: 'Mark done' })).toHaveCount(0);
    await settled(page);

    await switchUser(page, 'owner@demo.test', riskPath);
    const theirs = page.getByRole('listitem', { name: 'Treatment action: Fit a blade guard.' });
    await theirs.getByRole('button', { name: 'Mark done' }).click();
    const done = page.getByRole('dialog', { name: 'Mark the action done' });
    await expect(done.getByText(/Its control goes in place on this item/)).toBeVisible();
    // The demo API's today is its data's (15 Nov 2024), not the browser's.
    const doneOn = done.getByRole('textbox', { name: 'Done on' });
    await doneOn.fill('14 Nov 2024');
    await doneOn.press('Tab');
    await settledOpen(page);
    await done.getByRole('button', { name: 'Mark done' }).click();
    await expect(theirs.getByRole('button', { name: 'Mark done' })).toHaveCount(0);
    await expect(theirs.getByText('Done', { exact: true }).first()).toBeVisible();
    await expect(
      page
        .getByRole('listitem', { name: 'Control: Fit a blade guard.' })
        .getByText('Engineering · from a treatment action done 14 Nov 2024'),
    ).toBeVisible();
    await settled(page);
  });

  test('an objective takes a reading for a period', async ({ page }) => {
    // A quarter between 2000 and 2019 no other run has used, so a rerun never overlaps a reading.
    const q = Math.floor(Date.now() / 1000) % 80;
    const year = 2000 + Math.floor(q / 4);
    const [from, to] = [
      ['1 Jan', '31 Mar'],
      ['1 Apr', '30 Jun'],
      ['1 Jul', '30 Sep'],
      ['1 Oct', '31 Dec'],
    ][q % 4]!;
    await signIn(page, 'consultant@demo.test', `${ISO}/objectives`);
    await expect(page.getByRole('heading', { level: 1, name: 'Objectives' })).toBeVisible();
    await settled(page);
    await page.getByRole('link', { name: /^Cut grid electricity per tonne/ }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: /^Cut grid electricity/ }),
    ).toBeVisible();
    await expect(page.getByText('Every quarter')).toBeVisible();
    const before = await page.getByRole('listitem', { name: /^Reading for / }).count();
    await settled(page);

    await page.getByRole('button', { name: 'Record reading' }).click();
    const reading = page.getByRole('dialog', { name: 'Record reading' });
    await date(reading, 'Period from', `${from} ${year}`);
    await date(reading, 'Period to', `${to} ${year}`);
    await reading.getByRole('textbox', { name: 'Reading (kWh per tonne)' }).fill('430');
    await reading.getByRole('textbox', { name: 'Note (optional)' }).fill('Back-filled from bills.');
    await settledOpen(page);
    await reading.getByRole('button', { name: 'Record reading' }).click();
    await expect(page.getByRole('listitem', { name: /^Reading for / })).toHaveCount(before + 1);
    await expect(page.getByText('Back-filled from bills.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Objective plans' })).toBeVisible();
    await settled(page);
  });

  test('an owner lists the actions, filters them and opens one over the list', async ({ page }) => {
    await signIn(page, 'owner@demo.test', `${ISO}/actions?state=OPEN`);
    await expect(page.getByRole('heading', { level: 1, name: 'Actions' })).toBeVisible();
    await expect(page).toHaveTitle('Actions · Demo Metals · PlanetPulse Compliance');
    await expect(
      page.getByRole('group', { name: 'Filters' }).getByText('State: Open'),
    ).toBeVisible();
    await settled(page);
    const table = page.getByRole('table', { name: 'Actions' });
    await table.getByRole('link', { name: 'Qualify a second flour supplier.' }).click();
    await expect(page).toHaveURL(/state=OPEN&action=/);
    const drawer = page.getByRole('dialog', { name: 'Treatment action' });
    await expect(drawer.getByRole('link', { name: /^Risk: Buying flour/ })).toBeVisible();
    // Another person's action: the owner reads it but has no step on it.
    await expect(drawer.getByRole('button', { name: 'Mark done' })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: 'Edit action' })).toHaveCount(0);
    await settledOpen(page);
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(page).toHaveURL(/\/iso\/actions\?state=OPEN$/);

    await page.goto(`${ISO}/actions?ownerId=me`);
    await expect(
      page.getByRole('group', { name: 'Filters' }).getByText('Owner: Mine'),
    ).toBeVisible();
    await settled(page);
  });

  test('the risk register downloads with its filters', async ({ page }) => {
    let downloaded = '';
    await page.route(FILES, async (route) => {
      downloaded = route.request().url();
      await route.fulfill({
        status: 200,
        headers: { 'content-disposition': 'attachment; filename="risk-register.xlsx"' },
        body: 'register',
      });
    });
    await signIn(page, 'consultant@demo.test', `${ISO}/risks?significant=true`);
    await expect(page.getByRole('heading', { level: 1, name: 'Risks' })).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download risk register (Excel)' }).click();
    await download;
    expect(downloaded).toMatch(/^https:\/\/files\.mock\.invalid\/exports\//);
    await expect(
      page.getByRole('status').filter({ hasText: 'The download has started.' }),
    ).toBeVisible();
    await settled(page);
  });

  test('each overview count opens a list showing that many records', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', `${ISO}/overview`);
    await expect(page.getByRole('heading', { level: 1, name: 'ISO overview' })).toBeVisible();
    for (const [group, label, path, noun] of [
      ['Actions', /^\d+ open$/, /\/iso\/actions\?/, /actions?$/],
      ['Actions', /^\d+ overdue$/, /\/iso\/actions\?/, /actions?$/],
      ['Risks', /^\d+ significant$/, /\/iso\/risks\?/, /items?$/],
      ['Risks', /^\d+ review overdue$/, /\/iso\/risks\?ids=/, /items?$/],
      ['Objectives', /^\d+ open$/, /\/iso\/objectives\?/, /objectives?$/],
      ['Objectives', /^\d+ off track$/, /\/iso\/objectives\?ids=/, /objectives?$/],
      ['Documents', /^\d+ review overdue$/, /\/iso\/documents\?ids=/, /documents?$/],
    ] as const) {
      await page.goto(`${ISO}/overview`);
      const link = page.getByRole('region', { name: group }).getByRole('link', { name: label });
      const counted = (await link.innerText()).trim();
      await link.click();
      await expect(page).toHaveURL(path);
      expect(await shown(page, noun), `${group}: ${String(label)}`).toBe(counted);
    }
    await settled(page);
  });

  test('a risk item opens from the register by keyboard alone', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', `${ISO}/risks`);
    const first = page.getByRole('table', { name: 'Risk register' }).getByRole('link').first();
    await expect(first).toBeVisible();
    const name = (await first.innerText()).trim();
    const focused = () => page.evaluate<string>('document.activeElement?.textContent ?? ""');
    for (let i = 0; i < 80 && (await focused()).trim() !== name; i++)
      await page.keyboard.press('Tab');
    await expect(first).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Controls in place' })).toBeVisible();
  });

  test('every ISO-6b page says the add-on is off without it', async ({ page }) => {
    await signIn(page, 'company@demo.test', `${ISO}/overview`);
    for (const path of [
      'risks',
      'risks/00000000-0000-5000-8000-00000000abcd',
      'objectives',
      'objectives/00000000-0000-5000-8000-00000000abcd',
      'actions',
    ]) {
      await page.goto(`${ISO}/${path}`);
      await expect(page.getByRole('heading', { name: OFF })).toBeVisible();
      await expect(page).toHaveTitle('Not turned on · Demo Metals · PlanetPulse Compliance');
      await expect(page.getByRole('table')).toHaveCount(0);
      await checkPage(page);
    }
  });
});

test.describe('ISO screens part 2 at 375px on a phone', () => {
  test.use({
    viewport: { width: 375, height: 740 },
    userAgent: devices['iPhone 13'].userAgent,
    hasTouch: true,
    isMobile: true,
  });

  test('each page fits the screen, and an action opens full screen', async ({ page }) => {
    await signIn(page, 'owner@demo.test', `${ISO}/risks`);
    for (const [path, h1] of [
      ['risks', 'Risks'],
      ['objectives', 'Objectives'],
      ['actions', 'Actions'],
    ] as const) {
      await page.goto(`${ISO}/${path}`);
      await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
      await settled(page);
    }
    await page.getByRole('table', { name: 'Actions' }).getByRole('link').first().click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Back to actions' })).toBeVisible();
    await settledOpen(page);

    await page.goto(`${ISO}/risks`);
    await page.getByRole('table', { name: 'Risk register' }).getByRole('link').first().click();
    await expect(page.getByRole('heading', { name: 'Rating and significance' })).toBeVisible();
    await settled(page);
    await page.goto(`${ISO}/objectives`);
    await page.getByRole('table', { name: 'Objectives' }).getByRole('link').first().click();
    await expect(page.getByRole('heading', { name: 'Readings' })).toBeVisible();
    await settled(page);
  });
});
