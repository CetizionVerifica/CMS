import {
  REVIEW_FIGURE_KEYS,
  type ReviewFigureKeyInfo,
  type ReviewInputFigures,
} from '@canopy/contracts';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { IsoFigureRef, IsoReviewBook, IsoReviewInputRow } from '../dashboard/ports.js';
import { FOREST, localTime, MUTED, pdfSafe, Writer } from './certificate-pdf.js';
import { codeWords, FIGURE_WORDS, STANDARD_WORDS } from './iso-words.js';

/**
 * The management review pack (docs/iso/model.md §3.13, §9) as a PDF: the review, each input with its notes and, where
 * its definition names a source, its figures, then each output with its decision, then the review's actions. Values
 * print as the review has them (stored, or computed for a PLANNED review); only the references behind them are cut to
 * the records the requester may read (plan §3.3), and an INCIDENTS row that counts an incident the requester may not
 * open is withheld from anyone but the chair and the attendees (model §3.13 item 4).
 */

export const WITHHELD = 'Figures and notes withheld: they count incidents you may not open';
export const NO_FIGURES = 'No figures: held before the system was set up in the app';

const KEYS = REVIEW_FIGURE_KEYS as Record<string, Record<string, ReviewFigureKeyInfo>>;
const WORDS = FIGURE_WORDS as Record<string, Record<string, string>>;

/** The figure's meaning, or none for a key the contract does not list (it still prints, by its key). */
const infoOf = (source: string, key: string): ReviewFigureKeyInfo | undefined =>
  KEYS[source]?.[key];

/**
 * Each figure's ids with their table, in input then figure order, for M3's `isoVisibleIds`; `at` places each answer
 * back on its input and figure. A score, and a key the contract does not list, name no table and so no references.
 */
export function reviewFigureRefs(book: IsoReviewBook): {
  refs: IsoFigureRef[];
  at: { input: number; figure: number }[];
} {
  const refs: IsoFigureRef[] = [];
  const at: { input: number; figure: number }[] = [];
  book.inputs.forEach((input, i) => {
    input.figures?.figures.forEach((figure, f) => {
      const table = infoOf(input.figures!.source, figure.key)?.entityType;
      if (table && figure.ids.length > 0) {
        refs.push({ table, ids: figure.ids });
        at.push({ input: i, figure: f });
      }
    });
  });
  return { refs, at };
}

export interface PackFigure {
  words: string;
  value: string;
  /** References of the records behind the figure that the requester may open. */
  references: string[];
}

export interface PackInput {
  title: string;
  clause: string;
  /** What the figures are: the window and when they were recorded, a draft, none, or withheld; null for none. */
  heading: string | null;
  figures: PackFigure[];
  notes: string | null;
}

/** The value in words: "N", "N (M you can open)" when fewer ids are readable, "N (M records you can open)". */
function valueWords(info: ReviewFigureKeyInfo | undefined, value: number, readable: number) {
  if (info?.countsIds) return readable < value ? `${value} (${readable} you can open)` : `${value}`;
  if (info?.entityType) {
    return `${value} (${readable} ${readable === 1 ? 'record' : 'records'} you can open)`;
  }
  return `${value}`;
}

function heading(
  book: IsoReviewBook,
  figures: ReviewInputFigures,
  input: IsoReviewInputRow,
  timeZone: string,
) {
  if (book.review.state === 'PLANNED') {
    return `Draft: figures for ${figures.since} to ${figures.asOf}`;
  }
  return `Figures for ${figures.since} to ${figures.asOf}, recorded ${localTime(
    input.row.figuresStoredAt!,
    timeZone,
  )} (engine ${input.row.figuresEngineVersion!})`;
}

/**
 * The inputs as the requester reads them: `visible` is `isoVisibleIds`' answer to `reviewFigureRefs(book).refs` and
 * `labels` the references of those ids.
 */
export function packInputs(
  book: IsoReviewBook,
  visible: readonly (readonly string[])[],
  labels: ReadonlyMap<string, string>,
  reader: { personId: string; timeZone: string },
): PackInput[] {
  const { at } = reviewFigureRefs(book);
  const shown = new Map(at.map((place, n) => [`${place.input}/${place.figure}`, visible[n]!]));
  const { review } = book;
  const takesPart =
    review.chairId === reader.personId || review.attendeeIds.includes(reader.personId);
  return book.inputs.map((input, i) => {
    const base = { title: input.def.title, clause: input.clause, notes: input.row.notes };
    if (input.def.source === 'MANUAL' || review.state === 'CANCELLED') {
      return { ...base, heading: null, figures: [] };
    }
    if (input.figures === null) return { ...base, heading: NO_FIGURES, figures: [] };
    const source = input.figures.source;
    let cut = false;
    const figures = input.figures.figures.map((figure, f) => {
      const ids = shown.get(`${i}/${f}`) ?? [];
      cut ||= ids.length < figure.ids.length;
      const info = infoOf(source, figure.key);
      return {
        words: WORDS[source]?.[figure.key] ?? figure.key,
        value: valueWords(info, figure.value, ids.length),
        references: ids.map((id) => labels.get(id)).filter((l): l is string => l !== undefined),
      };
    });
    if (input.def.source === 'INCIDENTS' && cut && !takesPart) {
      return { ...base, heading: WITHHELD, figures: [], notes: null };
    }
    return { ...base, heading: heading(book, input.figures, input, reader.timeZone), figures };
  });
}

export interface ReviewPackData {
  clientName: string;
  book: IsoReviewBook;
  inputs: PackInput[];
  /** UTC instant the file was made; printed in `timeZone`. */
  generatedAt: string;
  timeZone: string;
}

export async function reviewPackPdf(data: ReviewPackData): Promise<Uint8Array> {
  const { book } = data;
  const { review, names } = book;
  const doc = await PDFDocument.create();
  const generated = new Date(data.generatedAt);
  doc.setTitle(pdfSafe(`Management review pack · ${review.heldOn ?? review.plannedOn}`));
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
    pdfSafe(`PlanetPulse Compliance · generated ${localTime(data.generatedAt, data.timeZone)}`),
  );
  const person = (id: string) => names.people.get(id) ?? '';
  const line = (label: string, value: string) => w.paragraph(`${label}: ${value}`, 10);

  w.paragraph('PlanetPulse Compliance', 10, bold, FOREST);
  w.gap(6);
  w.paragraph('Management review pack', 22, bold);
  w.gap(4);
  w.paragraph(
    `${data.clientName} / ${names.systems.get(review.managementSystemId) ?? ''} / ${review.standards
      .map((s) => STANDARD_WORDS[s])
      .join(', ')}`,
    10,
    regular,
    MUTED,
  );
  w.gap(8);
  if (review.state === 'CANCELLED')
    w.paragraph(`Cancelled: ${review.cancelReason ?? ''}`, 11, bold);
  if (review.state === 'PLANNED') {
    w.paragraph('Draft: this review is planned and not yet held.', 11, bold);
  }
  line('State', codeWords(review.state));
  line('Planned on', review.plannedOn);
  line('Held on', review.heldOn ?? 'Not yet held');
  line('Chair', person(review.chairId));
  line(
    'Attendees',
    review.attendeeIds.length === 0 ? 'None' : review.attendeeIds.map(person).join(', '),
  );

  w.heading('Minutes');
  w.paragraph(
    review.minutes ?? 'No minutes yet.',
    10,
    regular,
    review.minutes === null ? MUTED : undefined,
  );

  w.heading('Inputs');
  if (data.inputs.length === 0) w.paragraph('No inputs.', 10, regular, MUTED);
  for (const input of data.inputs) {
    w.gap(6);
    w.paragraph(`${input.title} (${input.clause})`, 11, bold);
    if (input.heading !== null) w.paragraph(input.heading, 10, regular, MUTED);
    for (const figure of input.figures) {
      w.paragraph(`${figure.words}: ${figure.value}`, 10);
      if (figure.references.length > 0) {
        w.paragraph(`Records: ${figure.references.join('; ')}`, 9, regular, MUTED);
      }
    }
    if (input.heading !== WITHHELD) w.paragraph(`Notes: ${input.notes ?? 'None'}`, 10);
  }

  w.heading('Outputs');
  if (book.outputs.length === 0) w.paragraph('No outputs.', 10, regular, MUTED);
  for (const output of book.outputs) {
    w.gap(6);
    w.paragraph(`${output.def.title} (${output.clause})`, 11, bold);
    w.paragraph(`Decision: ${output.row.decision ?? 'None recorded'}`, 10);
  }

  w.heading('Actions');
  if (book.actions.length === 0) w.paragraph('No review actions.', 10, regular, MUTED);
  for (const action of book.actions) {
    w.paragraph(
      `${action.text} · ${person(action.ownerId)} · due ${action.dueOn} · ${codeWords(action.state)}`,
      10,
    );
  }

  return doc.save();
}
