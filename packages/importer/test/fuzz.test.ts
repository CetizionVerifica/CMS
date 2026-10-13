import ExcelJS from 'exceljs';
import { beforeAll, describe, expect, it } from 'vitest';
import { recommendedDecisions } from '../src/decisions.js';
import { dryRun } from '../src/dry-run.js';
import { suggestMapping } from '../src/mapping.js';
import { firstNonEmptySheet, readWorkbook, type RawCell, type SourceSheet } from '../src/read.js';
import { EMPTY_STATE } from '../src/types.js';
import { analyse, loadSheet } from './helpers.js';

/**
 * Fuzz on the sample register (packages/importer/CLAUDE.md "Tests"): shuffled columns, extra columns,
 * missing optional columns, dates as text and as Excel serials, CSV instead of xlsx. Each variant must give the
 * same plan as the original under the recommended profile.
 */

let sample: SourceSheet;

beforeAll(async () => {
  sample = await loadSheet('sample-register-anonymised.xlsx');
});

function summary(sheet: SourceSheet) {
  const pending = analyse(sheet);
  const reviewed = analyse(sheet, { decisions: recommendedDecisions(pending.issues) });
  const { plan } = reviewed;
  return {
    counts: [
      plan.acts.length,
      plan.categories.length,
      plan.departments.length,
      plan.people.length,
      plan.obligations.length,
      plan.assignments.length,
      plan.instances.length,
    ],
    instances: plan.instances
      .map((i) => [i.key, i.workflowState, i.completedOn, i.owner].join('|'))
      .sort(),
    report: dryRun(reviewed, EMPTY_STATE).report,
  };
}

/** Deterministic shuffle (mulberry32), so a failure reproduces. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  let state = seed;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

function mapCells(
  sheet: SourceSheet,
  change: (header: string, cell: RawCell) => RawCell,
): SourceSheet {
  return {
    ...sheet,
    rows: sheet.rows.map((row) => ({
      ...row,
      cells: Object.fromEntries(Object.entries(row.cells).map(([h, c]) => [h, change(h, c)])),
    })),
  };
}

const toSerial = (iso: string) =>
  (Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(1899, 11, 30)) /
  86_400_000;
const toDayFirst = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const DATE_HEADERS = new Set(['Due Date', 'Activity Date']);

describe('import fuzz on the sample register', () => {
  let expected: ReturnType<typeof summary>;
  beforeAll(() => {
    expected = summary(sample);
  });

  it.each([1, 2, 3])('gives the same plan with shuffled columns (seed %i)', (seed) => {
    const headers = shuffled(sample.headers, seed);
    expect(summary({ ...sample, headers })).toEqual(expected);
  });

  it('ignores extra columns', () => {
    const sheet = mapCells(
      { ...sample, headers: [...sample.headers, 'Internal Notes', 'Column 21'] },
      (_h, c) => c,
    );
    for (const row of sheet.rows) {
      row.cells['Internal Notes'] = 'ignore me';
      row.cells['Column 21'] = 42;
    }
    const mapping = suggestMapping(sheet.headers);
    expect(mapping.slice(-2)).toEqual([
      { sourceHeader: 'Internal Notes', field: null },
      { sourceHeader: 'Column 21', field: null },
    ]);
    expect(summary(sheet)).toEqual(expected);
  });

  it('reads dates written as Excel serial numbers and as day-first text', () => {
    const serials = mapCells(sample, (h, c) =>
      DATE_HEADERS.has(h) && typeof c === 'string' ? toSerial(c) : c,
    );
    expect(summary(serials)).toEqual(expected);
    const text = mapCells(sample, (h, c) =>
      DATE_HEADERS.has(h) && typeof c === 'string' ? toDayFirst(c) : c,
    );
    expect(summary(text)).toEqual(expected);
  });

  it('still imports every row without the optional columns', () => {
    const optional = ['Applicability', 'Form Description', 'Log Sheet Description'];
    const sheet = { ...sample, headers: sample.headers.filter((h) => !optional.includes(h)) };
    const result = summary(sheet);
    expect(result.counts).toEqual(expected.counts);
    expect(result.report).toEqual(expected.report);
  });

  it('gives the same plan from a CSV export of the register', async () => {
    const lines = [
      sample.headers,
      ...sample.rows.map((row) => sample.headers.map((h) => row.cells[h] ?? '')),
    ];
    const csv = lines
      .map((cells) => cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\r\n');
    const workbook = await readWorkbook(new TextEncoder().encode(csv), 'register.csv');
    const sheet = firstNonEmptySheet(workbook);
    expect(sheet?.rows).toHaveLength(424);
    expect(summary(sheet as SourceSheet)).toEqual(expected);
  });

  it('gives the same plan from an xlsx whose dates are plain numbers', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Register');
    ws.addRow(sample.headers);
    for (const row of sample.rows) {
      ws.addRow(
        sample.headers.map((h) => {
          const cell = row.cells[h] ?? null;
          return DATE_HEADERS.has(h) && typeof cell === 'string' ? toSerial(cell) : cell;
        }),
      );
    }
    const workbook = await readWorkbook(
      new Uint8Array(await wb.xlsx.writeBuffer()),
      'register.xlsx',
    );
    expect(summary(firstNonEmptySheet(workbook) as SourceSheet)).toEqual(expected);
  });
});
