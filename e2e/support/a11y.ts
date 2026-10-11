import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

// WCAG 2.2 AA (PLAN.md, M14) as an automated gate: call this on every page a journey visits.
export async function expectNoA11yViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes)`)).toEqual([]);
}
