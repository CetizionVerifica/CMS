import ExcelJS from 'exceljs';
import { parseCsv } from './csv.js';

/** Reading an uploaded register file into sheets of raw rows. Values are kept exactly as read. */

/** Uploads above this size are refused (packages/importer/CLAUDE.md). */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export type RawCell = string | number | null;

export interface SourceRow {
  /** Sheet row number; the header is the first non-empty row, so data starts at 2 or later. */
  rowNumber: number;
  /** Cells keyed by header, as read. Holds personal data: never log it. */
  cells: Record<string, RawCell>;
}

export interface SourceSheet {
  name: string | null;
  headers: string[];
  rows: SourceRow[];
}

export interface SourceWorkbook {
  format: 'xlsx' | 'csv';
  sheets: SourceSheet[];
}

export type ImportFileErrorCode = 'FILE_TOO_LARGE' | 'UNSUPPORTED_FILE';

/** A file the importer cannot read. `code` is the API error code to return. */
export class ImportFileError extends Error {
  constructor(
    readonly code: ImportFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ImportFileError';
  }
}

export function fileFormatOf(fileName: string): 'xlsx' | 'csv' | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.xlsx')) return 'xlsx';
  if (lower.endsWith('.csv')) return 'csv';
  return null;
}

/** Reads an .xlsx or .csv upload. Throws ImportFileError for files that are too large or unreadable. */
export async function readWorkbook(bytes: Uint8Array, fileName: string): Promise<SourceWorkbook> {
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new ImportFileError('FILE_TOO_LARGE', 'The file is larger than 20 MB');
  }
  const format = fileFormatOf(fileName);
  if (format === 'csv') return { format, sheets: [readCsv(bytes)] };
  if (format === 'xlsx') return { format, sheets: await readXlsx(bytes) };
  throw new ImportFileError('UNSUPPORTED_FILE', 'Only .xlsx and .csv files can be imported');
}

/** The first sheet with at least one data row, or null when every sheet is empty. */
export function firstNonEmptySheet(workbook: SourceWorkbook): SourceSheet | null {
  return workbook.sheets.find((sheet) => sheet.rows.length > 0) ?? null;
}

function readCsv(bytes: Uint8Array): SourceSheet {
  let text: string;
  let records: string[][];
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    records = parseCsv(text);
  } catch {
    throw new ImportFileError('UNSUPPORTED_FILE', 'The CSV file could not be read as UTF-8 text');
  }
  return toSheet(
    null,
    records.map((cells, index) => ({ rowNumber: index + 1, values: cells })),
  );
}

async function readXlsx(bytes: Uint8Array): Promise<SourceSheet[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(toArrayBuffer(bytes));
  } catch {
    throw new ImportFileError('UNSUPPORTED_FILE', 'The file is not a readable .xlsx workbook');
  }
  return workbook.worksheets.map((worksheet) => {
    const rows: { rowNumber: number; values: RawCell[] }[] = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const values: RawCell[] = [];
      for (let col = 1; col <= worksheet.columnCount; col++) {
        values.push(cellValue(row.getCell(col).value));
      }
      rows.push({ rowNumber, values });
    });
    return toSheet(worksheet.name, rows);
  });
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/** Turns an ExcelJS cell value into a raw cell. Dates become YYYY-MM-DD (or a full ISO timestamp if timed). */
export function cellValue(value: ExcelJS.CellValue): RawCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return dateCell(value);
  if ('richText' in value) return value.richText.map((part) => part.text).join('');
  if ('hyperlink' in value) return cellValue(value.text);
  if ('result' in value) return cellValue(value.result as ExcelJS.CellValue);
  return null;
}

function dateCell(date: Date): RawCell {
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
}

function isBlank(cell: RawCell): boolean {
  return cell === null || (typeof cell === 'string' && cell.trim() === '');
}

/** The first non-empty row is the header; later non-empty rows are data. */
function toSheet(
  name: string | null,
  rows: { rowNumber: number; values: RawCell[] }[],
): SourceSheet {
  const nonEmpty = rows.filter((row) => !row.values.every(isBlank));
  const [headerRow, ...dataRows] = nonEmpty;
  if (!headerRow) return { name, headers: [], rows: [] };
  const headers = uniqueHeaders(headerRow.values);
  return {
    name,
    headers,
    rows: dataRows.map((row) => ({
      rowNumber: row.rowNumber,
      cells: Object.fromEntries(headers.map((header, i) => [header, row.values[i] ?? null])),
    })),
  };
}

/** Header text, trimmed; blanks become "Column N" and repeats get " (2)", " (3)". */
function uniqueHeaders(values: RawCell[]): string[] {
  const seen = new Map<string, number>();
  let last = values.length;
  while (last > 0 && isBlank(values[last - 1] ?? null)) last -= 1;
  return values.slice(0, last).map((value, i) => {
    const base = isBlank(value) ? `Column ${i + 1}` : String(value).trim().replace(/\s+/g, ' ');
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}
