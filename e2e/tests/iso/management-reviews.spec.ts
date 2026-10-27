import { devices, expect, type Locator, type Page, test } from '@playwright/test';

import { expectNoA11yViolations } from '../../support/a11y.js';
import { checkPage, DEMO_METALS, signIn } from '../shell/helpers.js';

// ISO screens part 3c (M17, docs/iso/packages.md ISO-6c) against the web app's demo API: a management review planned
// with its live figures, read by an owner who may open only some of the records behind them, given notes on every input
// and recorded as held; its stored figures staying as they were once a nonconformity it counted is closed; a review
// action naming an output; the demo review decided and closed; and the review pack beside the NC log and an audit
// report.
const ISO = `/c/${DEMO_METALS}/iso`;
const OFF = 'ISO management systems is not turned on for your account';
const FILES = 'https://files.mock.invalid/**';
const WITHHELD = 'Figures and notes withheld: they count incidents you may not open';
const NC_INPUT = 'Input: Nonconformities and corrective actions';

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

async function choose(page: Page, scope: Locator, label: string, option: string): Promise<void> {
  await scope.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

/** Types into a picker of several and chooses the first match. */
async function addTo(page: Page, scope: Locator, label: string, text: string): Promise<void> {
  await scope.getByRole('combobox', { name: label, exact: true }).fill(text);
  await page.getByRole('option').first().click();
}

async function date(scope: Locator, label: string, value: string): Promise<void> {
  const input = scope.getByRole('textbox', { name: label, exact: true });
  await input.fill(value);
  await input.press('Tab');
}

async function switchUser(page: Page, email: string, path: string): Promise<void> {
  await page.context().clearCookies();
  await signIn(page, email, path);
}

function standing(page: Page): Locator {
  return page.getByRole('region', { name: 'Where it stands' });
}

/** Confirms a step's dialog. */
async function confirm(page: Page, label: string): Promise<void> {
  await page.getByRole('alertdialog').getByRole('button', { name: label }).click();
}

/** The figures an input shows, as text. */
async function figures(page: Page, input: string): Promise<string> {
  const list = page.getByRole('listitem', { name: input }).locator('dl');
  await expect(list).toBeVisible();
  return (await list.innerText()).trim();
}

test.describe('ISO screens part 3c at 1280px', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('a review is planned, read with what each reader may open, held, and keeps its figures', async ({
    page,
  }) => {
    // Notes go on every input, each through its own drawer.
    test.setTimeout(240_000);
    await signIn(page, 'consultant@demo.test', `${ISO}/management-reviews`);
    await expect(page.getByRole('heading', { level: 1, name: 'Management reviews' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Next review due' })).toBeVisible();
    await settled(page);

    await page.getByRole('button', { name: 'Plan a management review' }).click();
    const plan = page.getByRole('dialog', { name: 'Plan a management review' });
    await plan.getByRole('checkbox', { name: 'ISO 9001' }).uncheck();
    await plan.getByRole('checkbox', { name: 'ISO 14001' }).uncheck();
    await date(plan, 'Planned for', '15 Nov 2024');
    await choose(page, plan, 'Chair', 'Sameer Gowda');
    await addTo(page, plan, 'Attendees (optional until it is held)', 'Divya');
    await settledOpen(page);
    await plan.getByRole('button', { name: 'Plan review' }).click();

    const title = 'Management review of 15 Nov 2024';
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(page).toHaveTitle(`${title} · Demo Metals · PlanetPulse Compliance`);
    const reviewPath = new URL(page.url()).pathname;
    await expect(standing(page).getByText('Planned', { exact: true })).toBeVisible();
    const ncInput = page.getByRole('listitem', { name: NC_INPUT });
    await expect(ncInput.getByText('Live, to today')).toBeVisible();
    await expect(page.getByRole('listitem', { name: 'Input: Incidents' })).not.toContainText(
      WITHHELD,
    );
    await settled(page);

    // The owner may not open every incident or nonconformity it counts: the incidents are withheld, and the counts say
    // how many records are theirs to open.
    await switchUser(page, 'owner@demo.test', reviewPath);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(page.getByRole('listitem', { name: 'Input: Incidents' })).toContainText(WITHHELD);
    await expect(ncInput.getByText(/^\d+ \(\d+ you can open\)$/).first()).toBeVisible();
    await expect(standing(page).getByRole('button', { name: 'Record as held' })).toHaveCount(0);
    await settled(page);

    // A nonconformity the review counts, raised before it is held.
    await switchUser(page, 'consultant@demo.test', `${ISO}/nonconformities`);
    const what = `Guard rail loose on the mezzanine ${Date.now().toString(36)}`;
    await page.getByRole('button', { name: 'Raise a nonconformity' }).click();
    const raise = page.getByRole('dialog', { name: 'Raise a nonconformity' });
    await choose(page, raise, 'Where it came from', 'Process');
    await raise.getByRole('radio', { name: 'Minor' }).check();
    await raise.getByRole('checkbox', { name: /^ISO 45001/ }).check();
    await choose(page, raise, 'Unit (optional)', 'Pune Plant');
    await raise.getByRole('textbox', { name: 'What happened or was found' }).fill(what);
    await choose(page, raise, 'Owner', 'Rohan Joshi');
    await choose(page, raise, 'Approver', 'Nisha Patil');
    await date(raise, 'Due on', '31 Dec 2030');
    await raise.getByRole('button', { name: 'Raise', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: what })).toBeVisible();
    const ncPath = new URL(page.url()).pathname;

    await page.goto(reviewPath);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    // Recording it as held waits for notes on every input.
    await standing(page).getByRole('button', { name: 'Record as held' }).click();
    let held = page.getByRole('dialog', { name: 'Record review as held' });
    await expect(held.getByText(/^No notes yet on: /)).toBeVisible();
    await settledOpen(page);
    await page.keyboard.press('Escape');

    const inputs = page.getByRole('region', { name: 'Inputs' }).getByRole('listitem');
    const count = await inputs.count();
    expect(count).toBeGreaterThan(5);
    for (let i = 0; i < count; i++) {
      const input = inputs.nth(i);
      await input.getByRole('button', { name: 'Add notes' }).click();
      const notes = page.getByRole('dialog', { name: /^Notes: / });
      await notes.getByRole('textbox', { name: 'Notes' }).fill(`Discussed, item ${i + 1}.`);
      await notes.getByRole('button', { name: 'Save notes' }).click();
      await expect(input.getByRole('button', { name: 'Edit notes' })).toBeVisible();
    }
    await settled(page);

    await standing(page).getByRole('button', { name: 'Record as held' }).click();
    held = page.getByRole('dialog', { name: 'Record review as held' });
    await expect(held.getByText(/^No notes yet on: /)).toHaveCount(0);
    // The demo API's today is its data's (15 Nov 2024), so the review is held then: before the app's own today, which
    // the form says the stored figures read some things as of.
    await date(held, 'Held on', '15 Nov 2024');
    await expect(
      held.getByText(/^The stored figures count the records up to 15 Nov 2024/),
    ).toBeVisible();
    await held.getByRole('textbox', { name: 'Minutes' }).fill('Quorate; the chair opened.');
    await settledOpen(page);
    await held.getByRole('button', { name: 'Record as held' }).click();
    await expect(standing(page).getByText('Held', { exact: true })).toBeVisible();
    await expect(standing(page).getByText('· held 15 Nov 2024')).toBeVisible();
    await expect(ncInput.getByText(/^Recorded .*, for .* to 15 Nov 2024$/)).toBeVisible();
    const stored = await figures(page, NC_INPUT);
    await settled(page);

    // A review action that carries out one of its outputs.
    await page.getByRole('button', { name: 'Add review action' }).click();
    const add = page.getByRole('dialog', { name: 'Add review action' });
    await add.getByRole('textbox', { name: 'What is to be done' }).fill('Brief every shift lead.');
    await choose(
      page,
      add,
      'Output it carries out (optional)',
      'Outputs communicated to workers and their representatives',
    );
    await choose(page, add, 'Owner', 'Sameer Gowda');
    await date(add, 'Due on', '31 Dec 2030');
    await settledOpen(page);
    await add.getByRole('button', { name: 'Add review action' }).click();
    const action = page.getByRole('listitem', { name: 'Review action: Brief every shift lead.' });
    await expect(
      action.getByText('Outputs communicated to workers and their representatives'),
    ).toBeVisible();
    // It is not closed while outputs wait for a decision and the action is open.
    await standing(page).getByRole('button', { name: 'Close review' }).click();
    await expect(page.getByRole('alertdialog')).toContainText(/without a decision, 1 still open\./);
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
    await settled(page);

    // The owner closes the nonconformity without corrective action and the approver verifies it.
    await switchUser(page, 'owner@demo.test', ncPath);
    await standing(page).getByRole('button', { name: 'Record root cause' }).click();
    const cause = page.getByRole('dialog', { name: 'Record root cause' });
    await cause.getByRole('textbox', { name: 'Containment' }).fill('Area taped off.');
    await cause.getByRole('textbox', { name: 'Correction' }).fill('Bolts tightened.');
    await choose(page, cause, 'Root cause method', 'Five whys');
    await cause.getByRole('textbox', { name: 'Root cause', exact: true }).fill('Vibration.');
    await cause.getByRole('textbox', { name: 'Similar occurrences' }).fill('None found.');
    await cause.getByRole('button', { name: 'Record root cause' }).click();
    await expect(standing(page).getByText('Root cause found', { exact: true })).toBeVisible();
    await standing(page).getByRole('button', { name: 'Close without corrective action' }).click();
    const none = page.getByRole('dialog', { name: 'Close without corrective action' });
    await none
      .getByRole('textbox', { name: 'Why no corrective action is needed' })
      .fill('The correction dealt with it.');
    await none.getByRole('textbox', { name: 'Risk review' }).fill('None needed.');
    await none.getByRole('textbox', { name: 'Change to the system' }).fill('None needed.');
    await none.getByRole('button', { name: 'Submit for verification' }).click();
    await expect(standing(page).getByText('Awaiting verification', { exact: true })).toBeVisible();

    await switchUser(page, 'approver@demo.test', ncPath);
    await standing(page).getByRole('button', { name: 'Verify effective' }).click();
    const verify = page.getByRole('dialog', { name: 'Verify effective' });
    await verify.getByRole('textbox', { name: 'How it was checked' }).fill('Rail checked.');
    await verify.getByRole('button', { name: 'Verify and close' }).click();
    await expect(standing(page).getByText('Closed', { exact: true })).toBeVisible();

    // The held review's figures are as they were stored.
    await switchUser(page, 'consultant@demo.test', reviewPath);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    expect(await figures(page, NC_INPUT)).toBe(stored);
    await settled(page);
  });

  test('the demo review gets its last decision, its open action done, and closes', async ({
    page,
  }) => {
    await signIn(page, 'consultant@demo.test', `${ISO}/management-reviews?state=HELD`);
    const link = page
      .getByRole('table', { name: 'Management reviews' })
      .getByRole('link', { name: 'Management review of 28 Oct 2024' });
    await link.click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Management review of 28 Oct 2024' }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('listitem', { name: NC_INPUT })
        .getByText(/^Recorded .*, for .* to 28 Oct 2024$/),
    ).toBeVisible();
    await settled(page);

    const output = page.getByRole('listitem', {
      name: 'Output: Outputs communicated to workers and their representatives',
    });
    await output.getByRole('button', { name: 'Record decision' }).click();
    const decide = page.getByRole('dialog', {
      name: 'Decision: Outputs communicated to workers and their representatives',
    });
    await decide
      .getByRole('textbox', { name: 'Decision' })
      .fill('Shared at the safety committee and on the notice boards.');
    await settledOpen(page);
    await decide.getByRole('button', { name: 'Save decision' }).click();
    await expect(
      output.getByText('Shared at the safety committee and on the notice boards.'),
    ).toBeVisible();

    // Its open action passes to an owner who signs in here, who marks it done.
    const reviewPath = new URL(page.url()).pathname;
    const open = page.getByRole('listitem', {
      name: 'Review action: Budget for an audit of the second flour supplier.',
    });
    await open.getByRole('button', { name: 'Edit action' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit review action' });
    await choose(page, edit, 'Owner', 'Rohan Joshi');
    await edit
      .getByRole('textbox', { name: 'Why the owner or due date changes' })
      .fill('Rohan runs supplier audits now.');
    await edit.getByRole('button', { name: 'Save action' }).click();
    await expect(open.getByText('Rohan Joshi')).toBeVisible();

    await switchUser(page, 'owner@demo.test', reviewPath);
    await open.getByRole('button', { name: 'Mark done' }).click();
    const done = page.getByRole('dialog', { name: 'Mark the action done' });
    await date(done, 'Done on', '14 Nov 2024');
    await done.getByRole('button', { name: 'Mark done' }).click();
    await expect(open.getByRole('button', { name: 'Mark done' })).toHaveCount(0);

    await switchUser(page, 'consultant@demo.test', reviewPath);
    await standing(page).getByRole('button', { name: 'Close review' }).click();
    await expect(page.getByRole('alertdialog')).toContainText(
      'Its notes and decisions are then final.',
    );
    await confirm(page, 'Close review');
    await expect(standing(page).getByText('Closed', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^(Edit|Add|Record) / })).toHaveCount(0);
    await settled(page);
  });

  test('a review downloads its pack, the NC log and an audit report', async ({ page }) => {
    const downloaded: string[] = [];
    await page.route(FILES, async (route) => {
      downloaded.push(route.request().url());
      await route.fulfill({
        status: 200,
        headers: { 'content-disposition': 'attachment; filename="export"' },
        body: 'file',
      });
    });
    await signIn(page, 'consultant@demo.test', `${ISO}/management-reviews`);
    await page
      .getByRole('table', { name: 'Management reviews' })
      .getByRole('link', { name: 'Management review of 28 Oct 2024' })
      .click();
    await expect(page.getByRole('heading', { name: 'Downloads' })).toBeVisible();
    for (const label of [
      'Download review pack (PDF)',
      'Download NC log (Excel)',
      'Download audit report (PDF)',
    ]) {
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: label }).click();
      await download;
    }
    expect(downloaded).toHaveLength(3);
    for (const url of downloaded) expect(url).toMatch(/^https:\/\/files\.mock\.invalid\/exports\//);
    await settled(page);
  });

  test('every management review page says the add-on is off without it', async ({ page }) => {
    await signIn(page, 'company@demo.test', `${ISO}/overview`);
    for (const path of [
      'management-reviews',
      'management-reviews/00000000-0000-5000-8000-00000000abcd',
    ]) {
      await page.goto(`${ISO}/${path}`);
      await expect(page.getByRole('heading', { name: OFF })).toBeVisible();
      await expect(page).toHaveTitle('Not turned on · Demo Metals · PlanetPulse Compliance');
      await expect(page.getByRole('table')).toHaveCount(0);
      await checkPage(page);
    }
  });
});

test.describe('ISO screens part 3c at 375px on a phone', () => {
  test.use({
    viewport: { width: 375, height: 740 },
    userAgent: devices['iPhone 13'].userAgent,
    hasTouch: true,
    isMobile: true,
  });

  test('the list, the plan form and a review fit the screen', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', `${ISO}/management-reviews`);
    await expect(page.getByRole('heading', { level: 1, name: 'Management reviews' })).toBeVisible();
    await settled(page);
    await page.getByRole('button', { name: 'Plan a management review' }).click();
    await expect(page.getByRole('dialog', { name: 'Plan a management review' })).toBeVisible();
    await settledOpen(page);
    await page.keyboard.press('Escape');
    await page
      .getByRole('table', { name: 'Management reviews' })
      .getByRole('link', { name: 'Management review of 28 Oct 2024' })
      .click();
    await expect(page.getByRole('heading', { name: 'The meeting' })).toBeVisible();
    await settled(page);
  });
});
