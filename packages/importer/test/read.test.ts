import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/csv.js';
import {
  cellValue,
  fileFormatOf,
  firstNonEmptySheet,
  ImportFileError,
  MAX_FILE_BYTES,
  readWorkbook,
} from '../src/read.js';

async function xlsxBytes(build: (wb: ExcelJS.Workbook) => void): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

describe('parseCsv', () => {
  it('reads quoted fields, escaped quotes, CRLF and a byte order mark', () => {
    const text = '﻿a,b,c\r\n"x, y","say ""hi""",\n"multi\nline",2,3';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', ''],
      ['multi\nline', '2', '3'],
    ]);
  });

  it('handles a trailing newline and bare CR line ends', () => {
    expect(parseCsv('a,b\rc,d\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('rejects an unterminated quote', () => {
    expect(() => parseCsv('"open,1')).toThrow('Unterminated');
  });
});

describe('readWorkbook', () => {
  it('reads a CSV with the header as the first non-empty record', async () => {
    const csv = '\n Owner ,Due Date,,Owner\nA,2022-04-07,x,B\n,,,\nC,07/04/2022,,D\n';
    const wb = await readWorkbook(new TextEncoder().encode(csv), 'register.CSV');
    expect(wb.format).toBe('csv');
    const sheet = wb.sheets[0];
    expect(sheet?.headers).toEqual(['Owner', 'Due Date', 'Column 3', 'Owner (2)']);
    expect(sheet?.rows).toEqual([
      {
        rowNumber: 3,
        cells: { Owner: 'A', 'Due Date': '2022-04-07', 'Column 3': 'x', 'Owner (2)': 'B' },
      },
      {
        rowNumber: 5,
        cells: { Owner: 'C', 'Due Date': '07/04/2022', 'Column 3': '', 'Owner (2)': 'D' },
      },
    ]);
  });

  it('refuses files that are not UTF-8 CSV, not xlsx, unreadable or too large', async () => {
    await expect(readWorkbook(new Uint8Array([0xff, 0xfe, 0x00]), 'a.csv')).rejects.toMatchObject({
      code: 'UNSUPPORTED_FILE',
    });
    await expect(readWorkbook(new TextEncoder().encode('"a'), 'a.csv')).rejects.toBeInstanceOf(
      ImportFileError,
    );
    await expect(readWorkbook(new Uint8Array([1, 2, 3]), 'a.xlsx')).rejects.toMatchObject({
      code: 'UNSUPPORTED_FILE',
    });
    await expect(readWorkbook(new Uint8Array(4), 'a.xls')).rejects.toMatchObject({
      code: 'UNSUPPORTED_FILE',
    });
    await expect(readWorkbook(new Uint8Array(MAX_FILE_BYTES + 1), 'a.xlsx')).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
    });
  });

  it('reads every xlsx sheet and picks the first non-empty one', async () => {
    const bytes = await xlsxBytes((wb) => {
      wb.addWorksheet('Empty');
      const ws = wb.addWorksheet('Register');
      ws.addRow(['Title', 'Due Date', 'Done', 'Rich', 'Link', 'Formula', 'Timed', 'Blank']);
      ws.addRow([
        'Return',
        new Date(Date.UTC(2022, 3, 7)),
        true,
        { richText: [{ text: 'Form ' }, { text: 'XIV' }] },
        { text: 'Schedule.docx', hyperlink: 'https://example.invalid/s' },
        { formula: '1+1', result: 2 },
        new Date(Date.UTC(2022, 3, 7, 10, 30)),
        null,
      ]);
    });
    const wb = await readWorkbook(bytes, 'r.xlsx');
    expect(wb.sheets.map((s) => s.name)).toEqual(['Empty', 'Register']);
    const sheet = firstNonEmptySheet(wb);
    expect(sheet?.name).toBe('Register');
    expect(sheet?.rows[0]?.cells).toEqual({
      Title: 'Return',
      'Due Date': '2022-04-07',
      Done: 'TRUE',
      Rich: 'Form XIV',
      Link: 'Schedule.docx',
      Formula: 2,
      Timed: '2022-04-07T10:30:00.000Z',
      Blank: null,
    });
  });

  it('returns null when every sheet is empty', () => {
    expect(
      firstNonEmptySheet({ format: 'csv', sheets: [{ name: null, headers: [], rows: [] }] }),
    ).toBe(null);
  });
});

describe('cellValue', () => {
  it('converts the remaining ExcelJS value shapes', () => {
    expect(cellValue(undefined as unknown as ExcelJS.CellValue)).toBe(null);
    expect(cellValue(false)).toBe('FALSE');
    expect(cellValue(new Date(Number.NaN))).toBe(null);
    expect(cellValue({ error: '#N/A' } as ExcelJS.CellErrorValue)).toBe(null);
  });
});

describe('fileFormatOf', () => {
  it('knows xlsx and csv only', () => {
    expect(fileFormatOf('A.XLSX')).toBe('xlsx');
    expect(fileFormatOf('a.csv')).toBe('csv');
    expect(fileFormatOf('a.xlsm')).toBe(null);
  });
});
