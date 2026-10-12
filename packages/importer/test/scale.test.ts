import { describe, expect, it } from 'vitest';
import type { SourceSheet } from '../src/read.js';
import { analyse, stubInferRule } from './helpers.js';

/**
 * The API re-runs analyseImport after every review change, so it must stay close to linear in rows.
 * 20,000 rows took 6 s before the audit fix (quadratic issue bookkeeping) and about 0.7 s after it.
 * This measures the importer's own work, so it uses the stub inferRule; the engine's cost per distinct schedule
 * is the engine's (calls are memoised per run, see analyse.test.ts).
 */
const HEADERS = [
  'EY Compliance ID',
  'Compliance Title',
  'Type (TimeLine)',
  'Compliance Description',
  'Compliance Categorization',
  'Act',
  'Compliance Status',
  'Due Date',
  'Form Description',
  'Log Sheet Description',
  'Organization',
  'Location',
  'Owner',
  'Approvers',
  'Department',
  'Criticality',
];

function largeSheet(rows: number, people: number): SourceSheet {
  return {
    name: 'Register',
    headers: HEADERS,
    rows: Array.from({ length: rows }, (_, i) => {
      const obligation = Math.floor(i / 4);
      const month = String((i % 12) + 1).padStart(2, '0');
      return {
        rowNumber: i + 2,
        cells: {
          'EY Compliance ID': `HRS-WB-${obligation}-1-1`,
          'Compliance Title': `Return ${obligation % 500}`,
          'Type (TimeLine)': 'On Going',
          'Compliance Description': 'File the return.',
          'Compliance Categorization': `Category ${obligation % 20}`,
          Act: `Act ${obligation % 40}, 1948`,
          'Compliance Status': 'Pending',
          'Due Date': `2022-${month}-${String((i % 4) * 7 + 1).padStart(2, '0')}`,
          // Large issue groups: every row raises NULL_PLACEHOLDER, FILE_NOT_ATTACHED, ENUM_NORMALISED, ALIAS.
          'Form Description': 'NA',
          'Log Sheet Description': 'Schedule.docx',
          Organization: 'Group/ Company/ Plant',
          Location: 'India/ West Bengal/ Belur',
          // Hashed names, so no two are near matches.
          Owner: `owner ${(((obligation % people) * 2654435761) >>> 0).toString(36)}`,
          Approvers: `APPROVER ${(((obligation % 50) * 40503) >>> 0).toString(36)}`,
          Department: obligation % 2 ? 'HR' : 'Human Resources',
          Criticality: 'HIGH',
        },
      };
    }),
  };
}

describe('scale', () => {
  it('analyses 20,000 rows in well under the old 6 seconds', () => {
    const sheet = largeSheet(20_000, 500);
    const started = performance.now();
    const analysis = analyse(sheet, { inferRule: stubInferRule });
    const elapsed = performance.now() - started;
    expect(analysis.plan.instances).toHaveLength(20_000);
    expect(analysis.issues.find((i) => i.type === 'FILE_NOT_ATTACHED')?.rowNumbers).toHaveLength(
      20_000,
    );
    expect(elapsed).toBeLessThan(3_000);
  }, 30_000);
});
