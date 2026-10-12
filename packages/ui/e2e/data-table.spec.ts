import { expect, test } from '@playwright/test';

import { expectNoA11yViolations, expectNoPageOverflow, openPopup } from './a11y';

test('10,000-row table is virtualised, keyboard-driven and axe-clean', async ({ page }) => {
  await page.goto('/#/data-table');
  const table = page.getByRole('table', { name: 'Register' });
  await expect(table).toHaveAttribute('aria-rowcount', '10001');
  const rendered = await table.locator('tbody tr[data-row-index]').count();
  expect(rendered).toBeLessThan(60);
  await expectNoA11yViolations(page);
  await expectNoPageOverflow(page);

  const first = table.getByRole('link', { name: 'Tax collection at source return' }).first();
  await first.focus();
  await page.keyboard.press('ArrowDown');
  await expect(table.locator('[data-row-index="1"] [data-row-link]')).toBeFocused();

  // End jumps to the last of 10,000 rows within the frame budget of one key press.
  const started = Date.now();
  await page.keyboard.press('End');
  const last = table.locator('[data-row-index="9999"] [data-row-link]');
  await expect(last).toBeFocused();
  expect(Date.now() - started).toBeLessThan(1500);
  await expect(table.locator('tr[aria-rowindex="10001"]')).toBeVisible();

  await page.keyboard.press('Space');
  await expect(page.getByRole('status').filter({ hasText: 'selected' })).toHaveText('1 selected');
  await page.keyboard.press('Home');
  await expect(table.locator('[data-row-index="0"] [data-row-link]')).toBeFocused();
  // Checked at the top: mid-scroll, a row half under the sticky header has its checkbox partly covered, which axe's
  // target-size rule reports even though scrolling reveals it.
  await expectNoA11yViolations(page);
});

test('sorting 10,000 rows stays fast', async ({ page }) => {
  await page.goto('/#/data-table');
  const header = page.getByRole('columnheader', { name: 'Due date' });
  await expect(header).toBeVisible();
  // Two checks. Work: the demo's Due date column counts its comparisons, and an n log n sort of 10,000 rows makes about
  // 120,000 (n·log2 n is 133,000) while a quadratic one makes tens of millions, so a cap of 4·n·log2 n catches it at
  // any load. Time: measured inside the page against a baseline from the same run, so a loaded runner (several
  // merge-queue groups at once) slows both alike; it guards the render, not the sort's complexity. The baseline is the
  // median of five sorts of 10,000 date strings; a healthy click costs about 50-90 of them, unloaded or at 4-6x CPU
  // throttling.
  await page.evaluate(() => {
    (window as Window & { dueDateComparisons?: number }).dueDateComparisons = 0;
  });
  const { baseline, elapsed } = await header.evaluate(async (th) => {
    const dates = Array.from({ length: 10_000 }, (_, i) =>
      new Date(Date.UTC(2026, 3, 1) + ((i * 7919) % 730) * 86_400_000).toISOString().slice(0, 10),
    );
    const runs = [0, 1, 2, 3, 4].map(() => {
      const t = performance.now();
      [...dates].sort((a, b) => a.localeCompare(b));
      return performance.now() - t;
    });
    const sorted = new Promise<void>((resolve) => {
      new MutationObserver((_, o) => {
        if (th.getAttribute('aria-sort') === 'ascending') {
          o.disconnect();
          resolve();
        }
      }).observe(th, { attributes: true, attributeFilter: ['aria-sort'] });
    });
    const started = performance.now();
    th.querySelector('button')!.click();
    await sorted;
    return { baseline: runs.sort((a, b) => a - b)[2]!, elapsed: performance.now() - started };
  });
  await expect(header).toHaveAttribute('aria-sort', 'ascending');
  const comparisons = await page.evaluate(
    () => (window as Window & { dueDateComparisons?: number }).dueDateComparisons ?? 0,
  );
  expect(comparisons).toBeGreaterThan(10_000);
  expect(comparisons).toBeLessThan(4 * 10_000 * Math.log2(10_000));
  expect(
    elapsed,
    `sort took ${Math.round(elapsed)}ms; baseline ${baseline.toFixed(1)}ms`,
  ).toBeLessThan(Math.max(1000, 150 * baseline));
});

test('the column chooser and row menu are axe-clean while open', async ({ page }) => {
  await page.goto('/#/data-table');
  await page.getByRole('button', { name: 'Columns' }).click();
  await expect(page.getByRole('dialog', { name: 'Choose columns' })).toBeVisible();
  await expectNoA11yViolations(page);
  await page.keyboard.press('Escape');
  // Wait for the chooser to finish closing: it returns focus to its trigger when it unmounts, and on a loaded runner
  // that can land after the next focus move and steal the Enter meant for the row menu.
  await expect(page.getByRole('dialog', { name: 'Choose columns' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Columns' })).toBeFocused();

  const link = page.locator('[data-row-index="0"] [data-row-link]');
  await link.focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: /^Actions for / }).first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await expectNoA11yViolations(page, openPopup('[role="menu"]'));
});

test('states render inside the card', async ({ page }) => {
  await page.goto('/#/data-table');
  for (const state of ['Loading', 'Refetching', 'Error', 'No results']) {
    await page.getByRole('radio', { name: state }).check();
    await expectNoA11yViolations(page);
  }
  await expect(
    page.getByRole('heading', { name: 'No instances match these filters' }),
  ).toBeVisible();
});

test('a row opens the drawer; J moves on, Esc returns focus to the row', async ({ page }) => {
  await page.goto('/#/data-table');
  const link = page.locator('[data-row-index="2"] [data-row-link]');
  await link.focus();
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('heading', { level: 2 })).toBeFocused();
  await expect(drawer.getByText('PF-CL-00003')).toBeVisible();
  await expectNoA11yViolations(page, openPopup('[role="dialog"]'));
  await expectNoPageOverflow(page);
  await page.keyboard.press('j');
  await expect(drawer.getByText('ENV-CL-00004')).toBeVisible();

  await drawer.getByRole('button', { name: 'Send back' }).click();
  const confirm = page.getByRole('alertdialog', { name: /^Send back to/ });
  await expect(confirm.getByRole('textbox', { name: 'Reason (required)' })).toBeFocused();
  await expectNoA11yViolations(page, openPopup('[role="alertdialog"]'));
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();

  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(page).toHaveURL(/#\/data-table$/);
});

test('filters narrow the table and are axe-clean while open', async ({ page, isMobile }) => {
  await page.goto('/#/data-table');
  if (isMobile) {
    await page.getByRole('button', { name: 'Filters' }).click();
    const sheet = page.getByRole('dialog', { name: 'Filters' });
    await sheet.getByRole('button', { name: /^Status/ }).click();
    await sheet.getByRole('checkbox', { name: 'Overdue' }).click();
    await expectNoA11yViolations(page, openPopup('[role="dialog"]'));
    await sheet.getByRole('button', { name: 'Show 1,250 results' }).click();
    await expect(page.getByRole('button', { name: 'Filters (1)' })).toBeVisible();
  } else {
    const chip = page.getByRole('button', { name: 'Status', exact: true });
    await chip.focus();
    await page.keyboard.press('ArrowDown');
    const popover = page.getByRole('dialog', { name: 'Status filter' });
    await popover.getByRole('checkbox', { name: 'Overdue' }).focus();
    await page.keyboard.press('Space');
    await expectNoA11yViolations(page, openPopup('[role="dialog"]'));
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('button', { name: 'Status filter: Overdue. Change' }),
    ).toBeFocused();
  }
  await expect(page.getByText('1,250 instances', { exact: true })).toBeVisible();
  await expectNoPageOverflow(page);
});

test('saved views apply filters, show "Edited" and save under a new name', async ({ page }) => {
  await page.goto('/#/data-table');
  const trigger = page.getByRole('button', { name: /^View: / });
  await expect(trigger).toHaveText('View: Default');
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await expectNoA11yViolations(page, openPopup('[role="menu"]'));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveText('View: Overdue super critical');
  await expect(trigger).toBeFocused();
  await expect(page.getByText(/^[\d,]+ instances match$/)).not.toHaveText('10,000 instances match');

  // Search changes the state, so the view shows as edited; Discard puts it back.
  await page.getByRole('searchbox').fill('PF');
  await expect(page.getByText('• Edited')).toBeVisible();
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByText('• Edited')).toHaveCount(0);

  await trigger.click();
  await page.getByRole('menuitem', { name: 'Save current view…' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Save current view?' });
  await expectNoA11yViolations(page);
  await dialog.getByRole('textbox').fill('Overdue copy');
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveText('View: Overdue copy');
  await expect(trigger).toBeFocused();
});
