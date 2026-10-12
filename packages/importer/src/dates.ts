import { isLocalDate, type LocalDate } from '@canopy/contracts';
import type { RawCell } from './read.js';

/**
 * Reading calendar dates from source cells. Only parsing lives here: due-date and status maths is the engine's.
 * Accepted: YYYY-MM-DD (also the date part of an ISO timestamp), Excel serial numbers (1900 date system),
 * day-first D/M/YYYY with "/", "-" or "." separators (Indian default), and D Mon YYYY / D-Mon-YYYY,
 * all within PLAUSIBLE_FROM to PLAUSIBLE_TO.
 */

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** 1-12 for a full or three-letter month name (and "Sept"), else undefined. */
function monthOf(word: string): number | undefined {
  const w = word.toLowerCase();
  const index = MONTH_NAMES.findIndex(
    (name) => name === w || name.slice(0, 3) === w || (w === 'sept' && name === 'september'),
  );
  return index === -1 ? undefined : index + 1;
}

/**
 * Excel serials count days from 1899-12-30 for every date after Excel's phantom 29 Feb 1900 (serial 60).
 * Earlier serials are off by one in Excel itself and are not register dates, so they are refused.
 */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;
const MIN_SERIAL = 61;
/** 9999-12-31. */
const MAX_SERIAL = 2_958_465;

function build(year: number, month: number, day: number): LocalDate | null {
  const value = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isLocalDate(value) ? (value as LocalDate) : null;
}

export function fromExcelSerial(serial: number): LocalDate | null {
  if (!Number.isFinite(serial) || serial < MIN_SERIAL || serial > MAX_SERIAL) return null;
  const iso = new Date(EXCEL_EPOCH_MS + Math.floor(serial) * MS_PER_DAY).toISOString();
  return iso.slice(0, 10) as LocalDate;
}

export type DateRead = { kind: 'blank' } | { kind: 'date'; value: LocalDate } | { kind: 'invalid' };

/**
 * Register dates outside this window are refused as INVALID_DATE. It catches numbers that are not dates at all
 * (a year typed as 2022 reads as Excel serial 2022, i.e. 1905-07-14) and typos such as 2202.
 */
export const PLAUSIBLE_FROM = '1950-01-01';
export const PLAUSIBLE_TO = '2100-12-31';

function plausible(value: LocalDate | null): DateRead {
  if (value === null || value < PLAUSIBLE_FROM || value > PLAUSIBLE_TO) return { kind: 'invalid' };
  return { kind: 'date', value };
}

/** Reads one cell as a calendar date. */
export function readDate(cell: RawCell): DateRead {
  if (cell === null) return { kind: 'blank' };
  if (typeof cell === 'number') return plausible(fromExcelSerial(cell));
  const text = cell.trim();
  if (text === '') return { kind: 'blank' };
  return plausible(parseDateText(text));
}

function parseDateText(text: string): LocalDate | null {
  let match = /^(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+Z?)?$/.exec(text);
  if (match) return build(Number(match[1]), Number(match[2]), Number(match[3]));

  if (/^\d+(\.\d+)?$/.test(text)) return fromExcelSerial(Number(text));

  match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (match) return build(Number(match[3]), Number(match[2]), Number(match[1]));

  match = /^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s,-]+(\d{4})$/.exec(text);
  if (match) {
    const month = monthOf(match[2] ?? '');
    return month ? build(Number(match[3]), month, Number(match[1])) : null;
  }
  return null;
}
