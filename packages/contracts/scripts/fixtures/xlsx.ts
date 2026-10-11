// Minimal .xlsx reader for the fixture generator: first sheet, shared and inline strings, numbers.
// Enough for the sample register; not a general-purpose parser. Uses only node:zlib, so the
// generator adds no dependency.
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

export type Cell = string | number | null;

function readZip(path: string): Map<string, Buffer> {
  const zip = readFileSync(path);
  // End of central directory: signature 0x06054b50, searched from the end.
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  if (eocd < 0) throw new Error(`${path} is not a zip file`);
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = zip.subarray(start, start + compressedSize);
    files.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

/** Concatenated text of every <t> in a fragment (rich text runs included). */
function text(fragment: string): string {
  return [...fragment.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    .map((match) => unescapeXml(match[1] as string))
    .join('');
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? '';
  return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}

/** Rows of the first worksheet as arrays of cell values, in sheet order. */
export function readFirstSheet(path: string): Cell[][] {
  const files = readZip(path);
  const shared = files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  const strings = [...shared.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => text(m[1] as string));
  const sheet = files.get('xl/worksheets/sheet1.xml')?.toString('utf8');
  if (sheet === undefined) throw new Error('No xl/worksheets/sheet1.xml');
  const rows: Cell[][] = [];
  for (const row of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: Cell[] = [];
    for (const cell of (row[1] as string).matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1] as string;
      const body = cell[2] ?? '';
      const index = columnIndex(/\br="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? '');
      const type = /\bt="(\w+)"/.exec(attrs)?.[1];
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value: Cell = null;
      if (type === 's' && raw !== undefined) value = strings[Number(raw)] ?? null;
      else if (type === 'inlineStr') value = text(body);
      else if (type === 'str' && raw !== undefined) value = unescapeXml(raw);
      else if (raw !== undefined) value = Number(raw);
      cells[index] = value;
    }
    rows.push(Array.from(cells, (value) => value ?? null));
  }
  return rows;
}

/** Excel serial day (1900 date system) to YYYY-MM-DD. */
export function serialToDate(serial: number): string {
  const ms = Date.UTC(1899, 11, 30) + Math.round(serial) * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}
