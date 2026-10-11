import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

// Same rule set as the repo gate in e2e/support/a11y.ts (WCAG 2.2 AA, colour contrast included). packages/ui
// depends on nothing in the repo, so it keeps its own copy.
export async function expectNoA11yViolations(
  page: Page,
  scope: { include?: string; exclude?: string } = {},
): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags([
    'wcag2a',
    'wcag2aa',
    'wcag21a',
    'wcag21aa',
    'wcag22aa',
  ]);
  if (scope.include) builder = builder.include(scope.include);
  if (scope.exclude) builder = builder.exclude(scope.exclude);
  const { violations } = await builder.analyze();
  expect(
    violations.map(
      (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`,
    ),
  ).toEqual([]);
}

/**
 * While a modal popup (Radix Select, DropdownMenu) is open, Radix hides the rest of the page with aria-hidden and
 * traps focus, so axe's aria-hidden-focus rule fires on the hidden page. Check the popup itself instead.
 */
export const openPopup = (selector: string) => ({ include: selector });

/** The page itself never scrolls sideways (tables and frames scroll inside their card). */
export async function expectNoPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}
