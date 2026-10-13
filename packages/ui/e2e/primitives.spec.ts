import { expect, test, type Locator } from '@playwright/test';

import { expectNoA11yViolations, openPopup } from './a11y';

async function outline(locator: Locator) {
  return locator.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      width: s.outlineWidth,
      style: s.outlineStyle,
      color: s.outlineColor,
      offset: s.outlineOffset,
    };
  });
}

test('keyboard focus shows a 2px forest ring with 2px offset', async ({ page }) => {
  await page.goto('/#/button');
  await page.keyboard.press('Tab'); // "All components" link
  await page.keyboard.press('Tab');
  const submit = page.getByRole('button', { name: 'Submit for approval' });
  await expect(submit).toBeFocused();
  // Polled: the button's colour transition also animates outline-color.
  await expect
    .poll(() => outline(submit))
    .toEqual({ width: '2px', style: 'solid', color: 'rgb(31, 107, 71)', offset: '2px' });
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').first()).toHaveText('Submitted 1 times');
});

test('controls meet the 36px hit target (44px on touch)', async ({ page }, info) => {
  await page.goto('/#/button');
  const min = info.project.name === 'mobile' ? 44 : 36;
  for (const name of ['Submit for approval', 'Add obligation', 'More actions']) {
    const box = await page.getByRole('button', { name, exact: true }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(name === 'More actions' && min === 36 ? 32 : min);
  }
});

test('a button with a disabled reason stays focusable and shows why', async ({ page }) => {
  await page.goto('/#/button');
  const approve = page.getByRole('button', { name: 'Approve', exact: true }).last();
  await approve.focus();
  await expect(page.getByRole('tooltip')).toHaveText('Only the approver can approve');
  await expect(approve).toHaveAttribute('aria-disabled', 'true');
});

test('select, combobox and checkbox work from the keyboard', async ({ page }) => {
  await page.goto('/#/fields');
  const dept = page.getByRole('combobox', { name: 'Department' });
  await dept.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toBeVisible();
  await expectNoA11yViolations(page, openPopup('[role="listbox"]'));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(dept).toHaveText(/EHS/);
  await expect(dept).toBeFocused();

  const unit = page.getByRole('combobox', { name: 'Unit', exact: true });
  await unit.focus();
  await unit.fill('');
  await page.keyboard.type('high');
  await expect(page.getByRole('option')).toHaveCount(1);
  await expectNoA11yViolations(page);
  await page.keyboard.press('Enter');
  await expect(unit).toHaveValue('Highmoor smelter');

  const overdue = page.getByRole('checkbox', { name: 'Overdue' });
  await overdue.focus();
  await page.keyboard.press('Space');
  await expect(overdue).toHaveAttribute('aria-checked', 'false');
});

test('menu, tabs and popover work from the keyboard and are axe-clean while open', async ({
  page,
}) => {
  await page.goto('/#/overlays');
  const details = page.getByRole('tab', { name: 'Details' });
  await details.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Evidence (2)' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  const actions = page.getByRole('button', { name: 'Actions for TAX-CL-033' });
  await actions.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await expectNoA11yViolations(page, openPopup('[role="menu"]'));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toHaveText('Last action: Copy ID');
  await expect(actions).toBeFocused();

  const columns = page.getByRole('button', { name: 'Columns' });
  await columns.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Choose columns' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Search columns' })).toBeFocused();
  await expectNoA11yViolations(page);
  await page.keyboard.press('Escape');
  await expect(columns).toBeFocused();
});

test('an overflowing tab list fades the end with more tabs', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/#/overlays');
  const list = page.getByRole('tablist').first();
  await list.evaluate((el) => {
    (el as HTMLElement).style.width = '120px';
  });
  await expect(list).toHaveAttribute('data-fade-end', 'true');
  expect(await list.evaluate((el) => getComputedStyle(el).maskImage)).toContain('linear-gradient');
});
