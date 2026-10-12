import type { Breakdown, InstanceRow, ScoreResult } from '@canopy/contracts';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

/**
 * The compliance certificate for one unit and period (PLAN.md §5 screen 9) as a PDF. Every number is the
 * engine's `ScoreResult`; this file only lays it out. No personal data beyond what the register shows
 * the reader: no owner or approver names, no evidence.
 */

export interface CertificateData {
  clientName: string;
  companyName: string;
  unitName: string;
  locationLabel: string;
  periodLabel: string;
  asOf: string;
  /** UTC instant the file was made; printed in `timeZone`. */
  generatedAt: string;
  /** The client's IANA time zone (root rule 4). */
  timeZone: string;
  result: ScoreResult;
  byAct: Breakdown;
  /** Overdue instances, most overdue first. */
  overdue: readonly InstanceRow[];
}

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 50;
const INK = rgb(0.11, 0.16, 0.13);
const MUTED = rgb(0.38, 0.42, 0.4);
const FOREST = rgb(0.09, 0.33, 0.22);
const LINE = rgb(0.82, 0.85, 0.83);

/**
 * The standard PDF fonts encode WinAnsi only. Characters outside it (for example Devanagari names) become
 * "?" rather than failing the export.
 */
export function pdfSafe(text: string): string {
  return text.replace(/[^\x20-\x7e\xa0-\xff]/g, (ch) => (ch === '\n' || ch === '\t' ? ' ' : '?'));
}

/** "2026-10-12 11:30 Asia/Kolkata": an instant as a wall-clock time in the client's time zone. */
export function localTime(instant: string, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(instant))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${timeZone}`;
}

function percent(value: number | null): string {
  return value === null ? 'No items due' : `${value.toFixed(1)}%`;
}

class Writer {
  page: PDFPage;
  y: number;

  constructor(
    private readonly doc: PDFDocument,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
    private readonly footer: string,
  ) {
    this.page = this.addPage();
    this.y = PAGE.height - MARGIN;
  }

  private addPage(): PDFPage {
    const page = this.doc.addPage([PAGE.width, PAGE.height]);
    page.drawText(this.footer, { x: MARGIN, y: 28, size: 8, font: this.regular, color: MUTED });
    return page;
  }

  /** Starts a new page when fewer than `height` points are left. */
  ensure(height: number): void {
    if (this.y - height >= MARGIN) return;
    this.page = this.addPage();
    this.y = PAGE.height - MARGIN;
  }

  /** Cuts `text` to `width` points, ending in "...". */
  fit(text: string, width: number, font: PDFFont, size: number): string {
    const safe = pdfSafe(text);
    if (font.widthOfTextAtSize(safe, size) <= width) return safe;
    let cut = safe;
    while (cut.length > 0 && font.widthOfTextAtSize(`${cut}...`, size) > width)
      cut = cut.slice(0, -1);
    return `${cut}...`;
  }

  /** Wrapped paragraph. */
  paragraph(text: string, size = 10, font = this.regular, color = INK): void {
    const width = PAGE.width - 2 * MARGIN;
    const words = pdfSafe(text).split(' ');
    let line = '';
    const flush = () => {
      this.ensure(size + 4);
      this.page.drawText(line, { x: MARGIN, y: this.y - size, size, font, color });
      this.y -= size + 4;
      line = '';
    };
    for (const word of words) {
      const next = line === '' ? word : `${line} ${word}`;
      if (line !== '' && font.widthOfTextAtSize(next, size) > width) {
        flush();
        line = word;
      } else {
        line = next;
      }
    }
    if (line !== '') flush();
  }

  gap(points: number): void {
    this.y -= points;
  }

  heading(text: string): void {
    this.ensure(40);
    this.gap(8);
    this.paragraph(text, 12, this.bold, FOREST);
    this.gap(2);
  }

  /** A table row; `widths` are column widths in points, text is cut to fit. */
  row(cells: string[], widths: number[], options: { bold?: boolean; rule?: boolean } = {}): void {
    const size = 9;
    const font = options.bold ? this.bold : this.regular;
    this.ensure(size + 8);
    let x = MARGIN;
    cells.forEach((cell, i) => {
      const width = widths[i] ?? 60;
      this.page.drawText(this.fit(cell, width - 6, font, size), {
        x,
        y: this.y - size,
        size,
        font,
        color: INK,
      });
      x += width;
    });
    this.y -= size + 5;
    if (options.rule) {
      this.page.drawLine({
        start: { x: MARGIN, y: this.y + 2 },
        end: { x: PAGE.width - MARGIN, y: this.y + 2 },
        thickness: 0.5,
        color: LINE,
      });
      this.y -= 3;
    }
  }
}

const ACT_WIDTHS = [205, 50, 45, 50, 55, 40, 50];
const OVERDUE_WIDTHS = [120, 210, 70, 95];

export async function certificatePdf(data: CertificateData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const generated = new Date(data.generatedAt);
  doc.setTitle(pdfSafe(`Compliance certificate · ${data.unitName} · ${data.periodLabel}`));
  doc.setAuthor('PlanetPulse Compliance');
  doc.setCreator('PlanetPulse Compliance');
  doc.setProducer('PlanetPulse Compliance');
  doc.setCreationDate(generated);
  doc.setModificationDate(generated);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(
    doc,
    regular,
    bold,
    pdfSafe(
      `PlanetPulse Compliance · generated ${localTime(data.generatedAt, data.timeZone)} · engine ${data.result.engineVersion}`,
    ),
  );

  w.paragraph('PlanetPulse Compliance', 10, bold, FOREST);
  w.gap(6);
  w.paragraph('Compliance certificate', 22, bold);
  w.gap(4);
  w.paragraph(`${data.clientName} / ${data.companyName} / ${data.unitName}`, 12, bold);
  w.paragraph(data.locationLabel, 10, regular, MUTED);
  w.paragraph(`Period: ${data.periodLabel}. Status as at ${data.asOf}.`, 10, regular, MUTED);
  w.gap(12);

  const { counts } = data.result;
  w.paragraph(
    `As recorded in PlanetPulse Compliance on ${data.asOf}, the compliance score of ${data.unitName} ` +
      `for ${data.periodLabel} is ${percent(data.result.score)} and the on-time rate is ` +
      `${percent(data.result.onTimeRate)}. ${counts.COMPLIED} compliance items were complied with on time and ` +
      `${counts.COMPLIED_LATE} late; ${counts.OVERDUE} are overdue, ${counts.SUBMITTED} are awaiting ` +
      `approval, ${counts.DUE_SOON + counts.UPCOMING} are not yet due and ${counts.NOT_APPLICABLE} are ` +
      `not applicable.`,
    11,
  );

  w.heading('Status by Act');
  w.row(['Act', 'Complied', 'Late', 'Overdue', 'Awaiting', 'N/A', 'Score'], ACT_WIDTHS, {
    bold: true,
    rule: true,
  });
  for (const { label, result } of data.byAct.rows) {
    w.row(
      [
        label,
        String(result.counts.COMPLIED),
        String(result.counts.COMPLIED_LATE),
        String(result.counts.OVERDUE),
        String(result.counts.SUBMITTED),
        String(result.counts.NOT_APPLICABLE),
        percent(result.score),
      ],
      ACT_WIDTHS,
    );
  }
  if (data.byAct.rows.length === 0)
    w.paragraph('No compliance items in this period.', 10, regular, MUTED);

  w.heading('Overdue items');
  if (data.overdue.length === 0) {
    w.paragraph('None.', 10, regular, MUTED);
  } else {
    w.row(['Compliance ID', 'Obligation', 'Due date', 'Days overdue'], OVERDUE_WIDTHS, {
      bold: true,
      rule: true,
    });
    for (const r of data.overdue) {
      w.row([r.externalRef ?? '', r.title, r.dueDate, String(r.overdueDays ?? '')], OVERDUE_WIDTHS);
    }
  }

  return doc.save();
}
