// @vitest-environment node
// The JSON copy the component tests read must be what the mock API sends today. Rewrite it with
// `UPDATE_ISO_DATA=1 pnpm --filter @canopy/web test iso-data`, then `prettier --write` it.
import { readFileSync, writeFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { isoData } from './iso-data';

const FILE = new URL('./iso-data.json', import.meta.url);

it('the component tests read what the mock API sends', async () => {
  const data = JSON.parse(JSON.stringify(await isoData()));
  if (process.env.UPDATE_ISO_DATA) writeFileSync(FILE, `${JSON.stringify(data, null, 2)}\n`);
  expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual(data);
});
