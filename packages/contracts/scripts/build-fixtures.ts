// Writes packages/contracts/fixtures/*.json (docs/contracts/fixtures.md).
// Usage: pnpm --filter @canopy/contracts fixtures [path/to/sample-register.xlsx]
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { buildFirmA } from './fixtures/firm-a.js';
import { buildFirmB } from './fixtures/firm-b.js';
import { readFirstSheet } from './fixtures/xlsx.js';

const DEFAULT_XLSX = new URL('../../importer/fixtures/sample-register.xlsx', import.meta.url)
  .pathname;
const out = (file: string) => new URL(`../fixtures/${file}`, import.meta.url);
const write = (file: string, value: unknown) =>
  writeFileSync(out(file), `${JSON.stringify(value, null, 2)}\n`);

const xlsx = process.argv[2] ?? DEFAULT_XLSX;
if (existsSync(xlsx)) {
  const firmA = buildFirmA(readFirstSheet(xlsx), 'sample-register.xlsx');
  write('firm-a.sample.json', firmA.sample);
  write('firm-a.due-dates.json', firmA.dueDates);
  write('firm-a.expected.json', firmA.expected);
} else {
  console.warn(`${basename(xlsx)} not found; firm A left as committed.`);
}
write('firm-b.synthetic.json', buildFirmB());
execFileSync('prettier', ['--write', out('').pathname], { stdio: 'inherit' });
