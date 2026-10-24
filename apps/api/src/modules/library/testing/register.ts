import { readFile } from 'node:fs/promises';
import { inferRule } from '@canopy/engine';
import {
  analyseImport,
  EMPTY_STATE,
  firstNonEmptySheet,
  readWorkbook,
  recommendedDecisions,
  suggestMapping,
  type ImportPlan,
} from '@canopy/importer';

const SAMPLE = new URL(
  '../../../../../../packages/importer/fixtures/sample-register-anonymised.xlsx',
  import.meta.url,
);

/**
 * The anonymised sample register planned into an empty account with the "recommended" profile
 * (docs/contracts/fixtures.md §3), the same decisions `pnpm db:seed` takes. The source of master library v2.
 */
export async function sampleRegisterPlan(): Promise<ImportPlan> {
  const bytes = new Uint8Array(await readFile(SAMPLE));
  const sheet = firstNonEmptySheet(await readWorkbook(bytes, 'sample-register-anonymised.xlsx'));
  if (!sheet) throw new Error('The sample register has no data');
  const input = {
    sheet,
    mapping: suggestMapping(sheet.headers),
    existing: EMPTY_STATE,
    inferRule,
    calendar: { fyStartMonth: 4, holidayPolicy: 'NONE' } as const,
  };
  const pending = analyseImport(input);
  return analyseImport({ ...input, decisions: recommendedDecisions(pending.issues) }).plan;
}

/**
 * The register files one site's consent renewal under an "Act" that names the site. The master library files it
 * under the two laws the consent is granted under, so no account's library names another company's plant.
 */
export const SAMPLE_ACT_NAMES: Readonly<Record<string, string>> = {
  'Kestrel Aluminium Limited, Riverbend , Renewal of Consent to Operate under Water (Prevention and Control of Pollution) Act and Air (Prevention and Control of Pollution) Act':
    'Water (Prevention and Control of Pollution) Act, 1974 and Air (Prevention and Control of Pollution) Act, 1981',
};

/**
 * Four register titles are the sample site's own petroleum and fire licence numbers, which a public registry ties
 * to the plant. The master library gives them what each licence is for; description, rule and forms stay.
 */
export const SAMPLE_TITLES: Readonly<Record<string, string>> = {
  'INT-H-047-0016': 'Petroleum licence (Form LS-1A)',
  'INT-H-048-0002': 'Licence to store petroleum (Form XV)',
  'INT-H-050-0002': 'Licence to import and store petroleum (Form XIV)',
  'INT-H-056-0001': 'Fire licence for storing or processing hazardous substances',
};
