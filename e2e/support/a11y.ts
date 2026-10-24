import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

// WCAG 2.2 AA (PLAN.md, M14) as an automated gate: call this on every page a journey visits.
export async function expectNoA11yViolations(page: Page): Promise<void> {
  // Next drops the document title for a moment while a server action's result renders. Wait for it, so axe's
  // document-title rule judges the settled page; a page that never gets a title still fails, here.
  await expect.poll(() => page.title(), { message: 'the page never got a <title>' }).not.toBe('');
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes)`)).toEqual([]);
}
