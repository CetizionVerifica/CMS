import { randomUUID } from 'node:crypto';
import { ExportJob, REVIEW_FIGURE_KEYS, type RequestContext } from '@canopy/contracts';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorld } from '../dashboard/testing/world.js';
import { FIGURE_WORDS } from './iso-words.js';
import { NO_FIGURES, packInputs, WITHHELD } from './review-pack-pdf.js';
import { addIsoRecords, addIsoReviews } from './testing/iso-records.js';
import { pdfText } from './testing/pdf-text.js';

/**
 * ISO-11d part 3 (docs/iso/model.md §3.13, §9): the management review pack through the export route and the worker on
 * the memory store: figures by the review's state, values the same for every reader, references cut to the records the
 * requester may open (plan §3.3), and the INCIDENTS row withheld from a reader who may not open an incident it counts,
 * unless they chair or attend. The same reads on Postgres are in iso.db.test.ts.
 */

const w = createWorld();
const records = addIsoRecords(w);
const reviews = addIsoReviews(w, records);
afterAll(() => w.app.close());
beforeEach(() => {
  w.setIso(true);
  w.store.firms.delete(w.firmId);
});

const admin = () => w.as('FIRM_ADMIN').headers;
const plantApprover = (personId?: string) =>
  w.as('APPROVER', { unitIds: [w.unit1] }, personId).headers;

function startExport(managementReviewId: string, headers = admin()) {
  return w.app.inject({
    method: 'POST',
    url: `/api/v1/clients/${w.clientId}/exports`,
    headers,
    payload: { kind: 'ISO_REVIEW_PACK_PDF', filters: `managementReviewId=${managementReviewId}` },
  });
}

const ctx = { firmId: w.firmId } as RequestContext;

async function pack(managementReviewId: string, headers = admin()) {
  const res = await startExport(managementReviewId, headers);
  expect(res.statusCode).toBe(202);
  const job = ExportJob.parse(res.json());
  await w.runner.idle();
  const done = await w.store.getExportJob(ctx, job.id);
  expect(done?.status).toBe('DONE');
  const bytes = w.files.files.get((await w.store.exportStorageKey(ctx, job.id))!)!.bytes;
  const title = (await PDFDocument.load(bytes)).getTitle();
  return { text: pdfText(bytes), fileName: done!.fileName, title };
}

const STORED_HEADING =
  'Figures for 2026-04-01 to 2026-09-30, recorded 2026-09-30 18:00 Asia/Kolkata (engine 1.2.0)';

describe('the management review pack', () => {
  it('prints a held review: its stored figures with their heading, notes, outputs and actions', async () => {
    const { text, fileName, title } = await pack(reviews.held.id);
    // Planned for 2026-09-25 and held on 2026-09-30: the file and its title name the day it was held.
    expect(fileName).toBe('management-review-pack-2026-09-30.pdf');
    expect(title).toBe('Management review pack · 2026-09-30');
    for (const words of [
      'Management review pack',
      'Beta Group / Site system / ISO 9001, ISO 45001',
      'State: Held',
      'Held on: 2026-09-30',
      'Chair: Person Approver',
      'Attendees: Review Attendee',
      'Reviewed the year; guarding needs money.',
      'Nonconformities and corrective actions (ISO 9001 9.3.2 c)',
      STORED_HEADING,
      'Raised: 2',
      'Records: NC 1; NC 2',
      'Open: 1',
      'Notes: Two raised',
      'Incidents and near misses: 1',
      'Days lost: 4 (1 record you can open)',
      'Records: NC 3',
      'Notes: One lost-time injury on the roller line',
      'Customer satisfaction (ISO 9001 9.3.2 c)',
      'Notes: Survey score 4.2 of 5',
      'Opportunities for improvement (ISO 9001 9.3.3)',
      'Decision: Fit guards on every roller',
      'Buy two light curtains · Person Owner · due 2026-11-15 · Open',
    ]) {
      expect(text).toContain(words);
    }
    expect(text).not.toContain('Draft');
    expect(text).not.toContain(WITHHELD);
  });

  it('keeps the values for an approver of Plant, cuts the references, and withholds the incidents', async () => {
    const { text } = await pack(reviews.held.id, plantApprover());
    expect(text).toContain('Raised: 2 (1 you can open)');
    expect(text).toContain('Records: NC 1');
    expect(text).not.toContain('NC 2');
    expect(text).toContain(WITHHELD);
    expect(text).not.toContain('Incidents and near misses: 1');
    expect(text).not.toContain('One lost-time injury');
    // Other rows keep their notes.
    expect(text).toContain('Notes: Two raised');
  });

  it('shows the incidents to the chair and an attendee of Plant, with only the references they may open', async () => {
    for (const personId of [reviews.chairId, reviews.attendeeId]) {
      const { text } = await pack(reviews.held.id, plantApprover(personId));
      expect(text).not.toContain(WITHHELD);
      expect(text).toContain('Incidents and near misses: 1 (0 you can open)');
      expect(text).toContain('Notes: One lost-time injury on the roller line');
      expect(text).not.toContain('NC 3');
    }
  });

  it('gives an approver named on an incident at another unit its reference, and so the row', async () => {
    const { text } = await pack(reviews.held.id, plantApprover(records.investigatorId));
    expect(text).not.toContain(WITHHELD);
    expect(text).toContain('Records: NC 3');
  });

  it('heads a planned review as a draft with the figures computed for it', async () => {
    const { text, fileName } = await pack(reviews.planned.id);
    expect(fileName).toBe('management-review-pack-2027-03-15.pdf');
    expect(text).toContain('Draft: this review is planned and not yet held.');
    expect(text).toContain('Draft: figures for 2026-09-30 to 2026-10-12');
    expect(text).toContain('Records: NC 2');
    expect(text).toContain('Held on: Not yet held');
    expect(text).toContain('No minutes yet.');
    expect(text).toContain('No outputs.');
    expect(text).toContain('No review actions.');
  });

  it('says a review held before set-up has no figures, and a cancelled one none at all', async () => {
    const before = await pack(reviews.beforeSetUp.id);
    expect(before.text).toContain(NO_FIGURES);
    expect(before.text).toContain('Notes: From the paper register');
    const cancelled = await pack(reviews.cancelled.id);
    expect(cancelled.text).toContain('Cancelled: Merged into the March review');
    expect(cancelled.text).not.toContain('Figures for');
    expect(cancelled.text).not.toContain('Incidents and near misses');
    expect(cancelled.text).toContain('Notes: None');
  });

  it('answers 404 at create for an unknown review or one out of scope, and queues nothing', async () => {
    const jobs = w.store.jobs.size;
    const office = w.as('APPROVER', { unitIds: [w.unit1] }).headers;
    for (const [id, headers] of [
      [randomUUID(), admin()],
      [reviews.planned.id, office],
    ] as const) {
      const res = await startExport(id, headers);
      expect(res.statusCode).toBe(404);
    }
    expect(w.store.jobs.size).toBe(jobs);
    // The chair reads it from any unit.
    expect((await pack(reviews.planned.id, plantApprover(reviews.chairId))).text).toContain(
      'Draft: figures',
    );
  });
});

describe('figure words', () => {
  it('has words for every key REVIEW_FIGURE_KEYS lists', () => {
    for (const [source, keys] of Object.entries(REVIEW_FIGURE_KEYS)) {
      const words = (FIGURE_WORDS as Record<string, Record<string, string>>)[source]!;
      expect(Object.keys(words).sort()).toEqual(Object.keys(keys).sort());
      for (const text of Object.values(words)) expect(text).toMatch(/^[A-Z]/);
    }
  });

  it('prints a key the contract does not list by its key, with no references', async () => {
    const book = (await w.store.isoManagementReview(
      { firmId: w.firmId } as RequestContext,
      w.clientId,
      reviews.held.id,
      null,
      null,
    ))!;
    const odd = {
      ...book,
      inputs: [
        {
          ...book.inputs[0]!,
          figures: { ...reviews.stored.ncs, figures: [{ key: 'newKey', value: 3, ids: [] }] },
        },
      ],
    };
    const [input] = packInputs(odd, [], new Map(), { personId: 'x', timeZone: 'UTC' });
    expect(input!.figures).toEqual([{ words: 'newKey', value: '3', references: [] }]);
  });
});
