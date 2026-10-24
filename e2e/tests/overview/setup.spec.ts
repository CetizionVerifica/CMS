import { expect, test } from '@playwright/test';

import { expectNoA11yViolations } from '../../support/a11y.js';
import { DEMO_METALS, signIn } from '../shell/helpers.js';
import { checkSettled } from './settled.js';

// Setup screens (M13) against the web app's demo API. The mock keeps its data for the whole run, so each test
// names what it adds uniquely.
const DEPARTMENTS = `/c/${DEMO_METALS}/setup/departments`;
const REMINDERS = `/c/${DEMO_METALS}/setup/reminders`;
const ENTITIES = `/c/${DEMO_METALS}/setup/entities`;
const PEOPLE = `/c/${DEMO_METALS}/setup/people`;
const unique = () => Date.now().toString(36);

test.describe('setup', () => {
  test('a consultant adds, renames and merges departments', async ({ page }) => {
    const tag = unique();
    const quality = `Quality ${tag}`;
    const qc = `QC ${tag}`;
    await signIn(page, 'consultant@demo.test', DEPARTMENTS);
    await expect(page).toHaveTitle('Departments · Demo Metals · PlanetPulse Compliance');
    await expect(page.getByRole('heading', { level: 1, name: 'Departments' })).toBeVisible();
    await checkSettled(page);

    for (const name of [quality, qc]) {
      await page.getByLabel('Department name').fill(name);
      await page.getByRole('button', { name: 'Add department' }).click();
      await expect(
        page.getByRole('status').filter({ hasText: `${name} was added.` }),
      ).toBeVisible();
    }
    const table = page.getByRole('table', { name: 'Departments' });
    await expect(table.getByRole('rowheader', { name: quality })).toBeVisible();

    // A second department with the same name is refused in words.
    await page.getByLabel('Department name').fill(quality.toLowerCase());
    await page.getByRole('button', { name: 'Add department' }).click();
    await expect(
      page
        .getByRole('alert')
        .filter({ hasText: 'This client already has a department with that name.' }),
    ).toBeVisible();

    // Rename, with other spellings.
    await page.getByRole('button', { name: `Edit ${quality}` }).click();
    let drawer = page.getByRole('dialog', { name: quality });
    await drawer.getByLabel('Department name').fill(`Quality assurance ${tag}`);
    await drawer.getByLabel('Other spellings').fill(`QA ${tag}`);
    await expectNoA11yViolations(page);
    await drawer.getByRole('button', { name: 'Save changes' }).click();
    await expect(drawer).toBeHidden();
    const renamed = table.getByRole('row').filter({ hasText: `Quality assurance ${tag}` });
    await expect(renamed).toContainText(`QA ${tag}`);

    // Merge the QC department into it.
    await page.getByRole('button', { name: `Edit Quality assurance ${tag}` }).click();
    drawer = page.getByRole('dialog', { name: `Quality assurance ${tag}` });
    await drawer.getByRole('checkbox', { name: qc }).click();
    await drawer.getByRole('button', { name: 'Merge department' }).click();
    const confirm = page.getByRole('alertdialog', {
      name: `Merge ${qc} into Quality assurance ${tag}?`,
    });
    await expectNoA11yViolations(page);
    await confirm.getByRole('button', { name: 'Merge' }).click();
    await expect(drawer).toBeHidden();
    await expect(table.getByRole('rowheader', { name: qc, exact: true })).toHaveCount(0);
    await expect(renamed).toContainText(qc);
    await checkSettled(page);
  });

  test('a consultant changes the reminders and sees them read back', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', REMINDERS);
    await expect(page).toHaveTitle('Reminders · Demo Metals · PlanetPulse Compliance');
    await expect(page.getByRole('heading', { level: 1, name: 'Reminders' })).toBeVisible();
    await checkSettled(page);

    await page.getByLabel('Remind owners this many days before the due date').fill('10, 3, 0');
    const summary = page.getByRole('region', { name: 'With these settings' });
    await expect(summary).toContainText(
      'Owners are reminded 10 days and 3 days before the due date, and on the due date.',
    );
    await page.getByRole('combobox', { name: "Consultants' weekly digest" }).click();
    await page.getByRole('option', { name: 'Friday' }).click();
    await expect(summary).toContainText('every Friday');
    await page.getByRole('button', { name: 'Save reminders' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Reminder settings saved.' }),
    ).toBeVisible();

    // The saved values come back from the server.
    await page.reload();
    await expect(page.getByLabel('Remind owners this many days before the due date')).toHaveValue(
      '10, 3, 0',
    );
    await expect(page.getByRole('combobox', { name: "Consultants' weekly digest" })).toHaveText(
      'Friday',
    );

    // A value it cannot save is marked and holds the save.
    await page.getByLabel('Remind owners this many days before the due date').fill('120');
    await expect(
      page.getByLabel('Remind owners this many days before the due date'),
    ).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('button', { name: /Save reminders/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await checkSettled(page);
  });

  test('keyboard only: a department is added and opened for editing', async ({ page }) => {
    const name = `Legal ${unique()}`;
    await signIn(page, 'consultant@demo.test', DEPARTMENTS);
    await expect(page.getByRole('heading', { level: 1, name: 'Departments' })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Department name')).toBeFocused();
    await page.keyboard.type(name);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: `${name} was added.` })).toBeVisible();
    const edit = page.getByRole('button', { name: `Edit ${name}` });
    await edit.focus();
    await page.keyboard.press('Enter');
    const drawer = page.getByRole('dialog', { name });
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(edit).toBeFocused();
  });

  test('a client owner cannot open setup', async ({ page }) => {
    await signIn(page, 'owner@demo.test', DEPARTMENTS);
    await expect(page.getByLabel('Department name')).toHaveCount(0);
    await checkSettled(page);
    for (const path of [REMINDERS, ENTITIES, PEOPLE]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: /You don’t have access/ })).toBeVisible();
      await expect(
        page.getByRole('button', { name: /^(Save reminders|Add company|Add person)$/ }),
      ).toHaveCount(0);
      await checkSettled(page);
    }
  });

  test('keyboard only: a company is added and archived, a unit and a person opened', async ({
    page,
  }) => {
    const company = `Kestrel Fibres ${unique()}`;
    await signIn(page, 'consultant@demo.test', ENTITIES);
    await expect(page.getByRole('heading', { level: 1, name: 'Entities' })).toBeVisible();
    const field = page.getByLabel('New company name');
    await field.focus();
    await page.keyboard.type(company);
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('status').filter({ hasText: `${company} was added.` }),
    ).toBeVisible();

    // Archive with a reason: the dialog opens on its reason field; Cancel, then Archive, follow it.
    const archive = page.getByRole('button', { name: `Archive ${company}` });
    await archive.focus();
    await page.keyboard.press('Enter');
    const confirm = page.getByRole('alertdialog', { name: `Archive ${company}?` });
    await expect(confirm.getByLabel(/Reason/)).toBeFocused();
    await page.keyboard.type('Created by mistake');
    const archiveButton = confirm.getByRole('button', { name: 'Archive' });
    await page.keyboard.press('Tab'); // Cancel
    await page.keyboard.press('Tab');
    await expect(archiveButton).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('table', { name: 'Companies' }).getByRole('row').filter({ hasText: company }),
    ).toHaveCount(0);
    await checkSettled(page);

    // A unit's drawer opens from its Edit button and Escape returns focus there.
    const editUnit = page.getByRole('button', { name: /^Edit Pune Plant, / });
    await editUnit.focus();
    await page.keyboard.press('Enter');
    const unitDrawer = page.getByRole('dialog', { name: 'Pune Plant' });
    await expect(unitDrawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(unitDrawer).toBeHidden();
    await expect(editUnit).toBeFocused();

    await page.goto(PEOPLE);
    const editPerson = page.getByRole('button', { name: 'Edit Divya Hegde' });
    await editPerson.focus();
    await page.keyboard.press('Enter');
    const personDrawer = page.getByRole('dialog', { name: 'Divya Hegde' });
    await expect(personDrawer.getByLabel('Name')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(personDrawer).toBeHidden();
    await expect(editPerson).toBeFocused();
  });

  test('a consultant adds a company and a unit, moves the unit and archives it', async ({
    page,
  }) => {
    const tag = unique();
    const company = `Osprey Textiles ${tag}`;
    const unit = `Highmoor Site ${tag}`;
    await signIn(page, 'consultant@demo.test', ENTITIES);
    await expect(page).toHaveTitle('Entities · Demo Metals · PlanetPulse Compliance');
    await checkSettled(page);

    await page.getByLabel('New company name').fill(company);
    await page.getByRole('button', { name: 'Add company' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: `${company} was added.` }),
    ).toBeVisible();
    await expect(
      page.getByRole('table', { name: 'Companies' }).getByRole('row').filter({ hasText: company }),
    ).toContainText('0 units');

    await page.getByRole('combobox', { name: 'Company' }).click();
    await page.getByRole('option', { name: company }).click();
    await page.getByRole('combobox', { name: 'Location' }).fill('Pune');
    await page.getByRole('option', { name: 'Pune, Maharashtra, India' }).click();
    await page.getByLabel('Unit name').fill(unit);
    await page.getByRole('button', { name: 'Add unit' }).click();
    const row = page
      .getByRole('table', { name: 'Units' })
      .getByRole('row')
      .filter({ hasText: unit });
    await expect(row).toContainText('Pune, Maharashtra, India');

    await page.getByRole('button', { name: `Edit ${unit}, ${company}` }).click();
    const drawer = page.getByRole('dialog', { name: unit });
    await drawer.getByRole('combobox', { name: 'Location' }).fill('Chennai');
    await page.getByRole('option', { name: 'Chennai, Tamil Nadu, India' }).click();
    await expectNoA11yViolations(page);
    await drawer.getByRole('button', { name: 'Save changes' }).click();
    await expect(drawer).toBeHidden();
    await expect(row).toContainText('Chennai, Tamil Nadu, India');

    await page.getByRole('button', { name: `Archive ${unit}, ${company}` }).click();
    const confirm = page.getByRole('alertdialog', { name: `Archive ${unit}?` });
    await confirm.getByLabel(/Reason/).fill('Site closed');
    await expectNoA11yViolations(page);
    await confirm.getByRole('button', { name: 'Archive' }).click();
    await expect(row).toHaveCount(0);
    await checkSettled(page);
  });

  test('a consultant adds a person, gives them an email and merges a duplicate', async ({
    page,
  }) => {
    const tag = unique();
    const name = `Meera Rao ${tag}`;
    const duplicate = `Meera R ${tag}`;
    await signIn(page, 'consultant@demo.test', PEOPLE);
    await expect(page).toHaveTitle('People · Demo Metals · PlanetPulse Compliance');
    await checkSettled(page);

    for (const person of [name, duplicate]) {
      await page.getByLabel('Name', { exact: true }).fill(person);
      await page.getByRole('button', { name: 'Add person' }).click();
      await expect(
        page.getByRole('status').filter({ hasText: `${person} was added.` }),
      ).toBeVisible();
    }
    const table = page.getByRole('table', { name: 'People' });
    await expect(table.getByRole('row').filter({ hasText: name })).toContainText('Not invited');

    await page.getByRole('button', { name: `Edit ${name}` }).click();
    const drawer = page.getByRole('dialog', { name });
    await expect(drawer.getByText('Owner · all units')).toBeVisible();
    await drawer.getByLabel('Email').fill(`meera.${tag}@kestrel.example`);
    await drawer.getByRole('checkbox', { name: duplicate }).click();
    await expectNoA11yViolations(page);
    await drawer.getByRole('button', { name: 'Merge person' }).click();
    await page
      .getByRole('alertdialog', { name: `Merge ${duplicate} into ${name}?` })
      .getByRole('button', { name: 'Merge' })
      .click();
    await expect(drawer).toBeHidden();
    await expect(table.getByRole('rowheader', { name: duplicate })).toHaveCount(0);

    await page.getByRole('button', { name: `Edit ${name}` }).click();
    const again = page.getByRole('dialog', { name });
    await again.getByLabel('Email').fill(`meera.${tag}@kestrel.example`);
    await again.getByRole('button', { name: 'Save changes' }).click();
    await expect(again).toBeHidden();
    await expect(table.getByRole('row').filter({ hasText: name })).toContainText('Invited');
    await checkSettled(page);
  });
});

test.describe('setup at 375px', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('every setup page fits the screen', async ({ page }) => {
    await signIn(page, 'consultant@demo.test', DEPARTMENTS);
    await expect(page.getByRole('heading', { level: 1, name: 'Departments' })).toBeVisible();
    await checkSettled(page);
    for (const [path, title] of [
      [REMINDERS, 'Reminders'],
      [ENTITIES, 'Entities'],
      [PEOPLE, 'People'],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      await checkSettled(page);
    }
  });
});
