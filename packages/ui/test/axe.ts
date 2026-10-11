import axe from 'axe-core';
import { expect } from 'vitest';

// axe in jsdom: structure, names, roles and ARIA. jsdom cannot compute colours, so `color-contrast` runs in the
// Playwright suite (e2e/) against the real browser, and src/contrast.test.ts checks the token pairs.
export async function expectNoAxeViolations(node: Element = document.body): Promise<void> {
  const { violations } = await axe.run(node, {
    runOnly: {
      type: 'tag',
      values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
    },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  expect(
    violations.map(
      (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`,
    ),
  ).toEqual([]);
}
