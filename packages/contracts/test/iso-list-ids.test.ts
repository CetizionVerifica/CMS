// ISO-1a4: the limits of `?ids=` on the five ISO lists that take it. What each list returns for it is tested beside
// the list's other filters (iso-nonconformities, iso-risks, iso-documents and iso-audits).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type App, fails, type Id, isoApp, ok, seedId } from './iso-harness.js';

let app: App;

beforeAll(async () => {
  app = await isoApp();
});
afterAll(async () => {
  await app.close();
});

const LISTS: Id[] = [
  'listIsoNonconformities',
  'listIsoRisks',
  'listIsoObjectives',
  'listIsoDocuments',
  'listIsoInternalAudits',
];
const fresh = (n: number) => Array.from({ length: n }, () => seedId());

describe.each(LISTS)('%s ?ids=', (list) => {
  it('takes up to 200 distinct ids on one page, leaving out the ones it does not hold', async () => {
    const page = await ok<{ items: unknown[]; total?: number }>(app, list, {
      query: { ids: fresh(200).join(','), limit: '200', count: 'true' },
    });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });

  it('refuses an empty list, a repeated id, 201 ids and a value that is not an id', async () => {
    const one = seedId();
    for (const ids of ['', ',', `${one},`, `${one},${one}`, fresh(201).join(','), 'NC-7']) {
      const error = await fails(app, list, { query: { ids } }, 'VALIDATION', 400);
      const { issues } = error.error.details as { issues: { path: unknown[] }[] };
      expect(issues.length, ids.slice(0, 40)).toBeGreaterThan(0);
      for (const issue of issues) expect(issue.path.slice(0, 2)).toEqual(['query', 'ids']);
    }
  });
});
