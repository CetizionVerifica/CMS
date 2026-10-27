import ExcelJS from 'exceljs';
import type { IsoArchive, IsoNames } from '../dashboard/ports.js';

/**
 * The client archive's register of ISO records (docs/iso/model.md §9): one sheet per kind of record, each row the
 * record as M3 holds it with one column per field, archived rows included; then each review input's stored figures,
 * one row per figure and id, in full; then the names of the people, units, systems and clauses the ids refer to. The
 * archive computes no figure: a review's figures are only those its inputs stored when it was held.
 */

/** A field as one cell: lists joined with "; ", anything nested as JSON, null as empty. */
function cellOf(value: unknown): string | number | boolean {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.join('; ');
  return JSON.stringify(value);
}

function addTable(
  workbook: ExcelJS.Workbook,
  name: string,
  columns: readonly string[],
  rows: readonly (readonly (string | number | boolean)[])[],
): void {
  const sheet = workbook.addWorksheet(name);
  sheet.addRow([...columns]).font = { bold: true };
  for (const row of rows) sheet.addRow([...row]);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

/** The fields of the rows, in the order they first appear. */
function columnsOf(rows: readonly Readonly<Record<string, unknown>>[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
  return [...seen];
}

function figureRows(archive: IsoArchive): (string | number)[][] {
  const out: (string | number)[][] = [];
  for (const { row, key } of archive.reviewInputs) {
    const stored = row.sourceFigures;
    if (stored === null) continue;
    for (const figure of stored.figures) {
      const head = [
        row.managementReviewId,
        row.id,
        key ?? '',
        stored.source,
        stored.since,
        stored.asOf,
        row.figuresStoredAt ?? '',
        row.figuresEngineVersion ?? '',
        figure.key,
        figure.value,
      ];
      // One row per id, so a long list never outgrows a cell; a figure with no ids keeps one row.
      if (figure.ids.length === 0) out.push([...head, '']);
      for (const id of figure.ids) out.push([...head, id]);
    }
  }
  return out;
}

function nameRows(names: IsoNames): string[][] {
  const kinds: [string, ReadonlyMap<string, string>][] = [
    ['Person', names.people],
    ['Unit', names.units],
    ['Management system', names.systems],
    ['Clause', names.clauses],
    ['Obligation', names.obligations],
  ];
  return kinds.flatMap(([kind, map]) => [...map].map(([id, name]) => [kind, id, name]));
}

export async function isoRecordsWorkbook(archive: IsoArchive): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'PlanetPulse Compliance';
  for (const sheet of archive.sheets) {
    const columns = columnsOf(sheet.rows);
    addTable(
      workbook,
      sheet.name,
      columns,
      sheet.rows.map((row) => columns.map((column) => cellOf(row[column]))),
    );
  }
  addTable(
    workbook,
    'Review figures',
    [
      'managementReviewId',
      'reviewInputId',
      'inputKey',
      'source',
      'since',
      'asOf',
      'figuresStoredAt',
      'figuresEngineVersion',
      'figure',
      'value',
      'id',
    ],
    figureRows(archive),
  );
  addTable(workbook, 'Names', ['kind', 'id', 'name'], nameRows(archive.names));
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
