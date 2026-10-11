import { expect, test } from '@playwright/test';

import { expectNoA11yViolations, expectNoPageOverflow, openPopup } from './a11y';

test('client switcher filters, navigates and is axe-clean while open', async ({ page }) => {
  await page.goto('/#/context');
  const trigger = page.getByRole('button', { name: 'Client: Hindalco Belur, change client' });
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  const panel = page.getByRole('dialog', { name: 'Change client' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('combobox', { name: 'Find a client' })).toBeFocused();
  await expectNoA11yViolations(page, openPopup('[role="dialog"]'));
  await expectNoPageOverflow(page);

  await page.keyboard.type('cement');
  await expect(panel.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(panel).toBeHidden();
  await expect(page).toHaveURL(/#\/context\?client=sc$/);

  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog', { name: 'Change client' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});

test('period picker moves across the grid and applies on Enter', async ({ page }) => {
  await page.goto('/#/context');
  const chip = page.getByRole('button', { name: 'Period: FY 2022–23, quarter 3, change period' });
  await chip.focus();
  await page.keyboard.press('Enter');
  const popover = page.getByRole('dialog', { name: 'Choose period' });
  await expect(popover.getByRole('radio', { name: /^Quarter 3/ })).toBeFocused();
  await expectNoA11yViolations(page, openPopup('[role="dialog"]'));
  await expectNoPageOverflow(page);
  await page.keyboard.press('ArrowDown');
  await expect(popover.getByRole('radio', { name: /^Quarter 3/ })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(popover).toBeHidden();
  await expect(page.getByRole('button', { name: /quarter 4, change period/ })).toHaveText(
    'FY 2022–23 · Q4',
  );

  // Months after the last generated one are disabled and explain why.
  await page.getByRole('button', { name: /October 2022, change period/ }).click();
  const feb = page.getByRole('radio', { name: 'February 2023' });
  await expect(feb).toHaveAttribute('aria-disabled', 'true');
  await expect(feb).toHaveAccessibleDescription('No instances generated yet');
  await expectNoA11yViolations(page, openPopup('[role="dialog"]'));
});

test('date input reads typed dates and picks from the calendar by keyboard', async ({ page }) => {
  await page.goto('/#/context');
  const due = page.getByRole('textbox', { name: 'Due date' });
  await expect(due).toHaveValue('31 Mar 2027');
  await due.fill('1/4/2027');
  await due.press('Enter');
  await expect(due).toHaveValue('1 Apr 2027');

  const calendarButton = page.getByRole('button', { name: 'Choose filed on from calendar' });
  await calendarButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('grid', { name: 'March 2027' })).toBeVisible();
  await expect(page.getByRole('button', { name: '10 March 2027' })).toBeFocused();
  await expectNoA11yViolations(page, openPopup('[role="dialog"]'));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Filed on' })).toHaveValue('11 Mar 2027');
  await expect(calendarButton).toBeFocused();
});

test('the shell uses the real switcher and period chip at every width', async ({ page }) => {
  await page.goto('/#/shell/overview?layout=auto');
  await page.getByRole('button', { name: /change client/ }).click();
  await expect(page.getByRole('dialog', { name: 'Change client' })).toBeVisible();
  await expectNoA11yViolations(page, openPopup('[role="dialog"]'));
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /change period/ }).click();
  await expect(page.getByRole('dialog', { name: 'Choose period' })).toBeVisible();
  await expectNoPageOverflow(page);
});

test('toasts are axe-clean, reachable with F8 and placed by width', async ({ page }) => {
  await page.goto('/#/feedback');
  // Keyboard, because on a phone the first toast sits over the next button.
  await page.getByRole('button', { name: 'Success with Undo' }).press('Enter');
  await page.getByRole('button', { name: 'Error', exact: true }).press('Enter');
  const region = page.getByRole('region', { name: /Notifications/ });
  await expect(region.getByText('Approved. 3 left in your queue.')).toBeVisible();
  await expect(region.getByText("Couldn't approve. Try again.")).toBeVisible();
  await expectNoA11yViolations(page);
  await expectNoPageOverflow(page);
  await page.keyboard.press('F8');
  await page.keyboard.press('Tab');
  const focusedInRegion = await region.evaluate((r) => r.contains(document.activeElement));
  expect(focusedInRegion).toBe(true);
});
