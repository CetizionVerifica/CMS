import { selfAuditors } from '@canopy/contracts';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { IsoAuditBook } from '../dashboard/ports.js';
import { FOREST, localTime, MUTED, pdfSafe, Writer } from './certificate-pdf.js';
import { codeWords, findingTypeWords } from './iso-words.js';

/**
 * The internal audit report (docs/iso/model.md §3.7, §3.9, §9) as a PDF: the audit's plan, the people and the
 * independence note (9.2.2), the summary, the checklist, the findings with the NCs they raised, and the findings'
 * improvement actions. Records only; it computes nothing.
 */

export interface AuditReportData {
  clientName: string;
  book: IsoAuditBook;
  /** UTC instant the file was made; printed in `timeZone`. */
  generatedAt: string;
  /** The client's IANA time zone (root rule 4). */
  timeZone: string;
}

/** What the report says about independence when no auditor is also an auditee (no note is then needed). */
export const NO_SELF_AUDIT = 'No auditor or lead auditor is also an auditee of this audit.';

export async function auditReportPdf(data: AuditReportData): Promise<Uint8Array> {
  const { book } = data;
  const { audit, names } = book;
  const doc = await PDFDocument.create();
  const generated = new Date(data.generatedAt);
  doc.setTitle(pdfSafe(`Internal audit report · ${audit.title}`));
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
  const people = (ids: readonly string[]) =>
    ids.length === 0 ? 'None' : ids.map(person).join(', ');
  const unit = (id: string | null) =>
    id === null ? 'The whole system' : (names.units.get(id) ?? '');
  const clauses = (ids: readonly string[]) =>
    ids.length === 0 ? 'None listed' : ids.map((id) => names.clauses.get(id) ?? '').join(', ');
  const line = (label: string, value: string) => w.paragraph(`${label}: ${value}`, 10);

  w.paragraph('PlanetPulse Compliance', 10, bold, FOREST);
  w.gap(6);
  w.paragraph('Internal audit report', 22, bold);
  w.gap(4);
  w.paragraph(audit.title, 14, bold);
  w.paragraph(
    `${data.clientName} / ${names.systems.get(book.programme.managementSystemId) ?? ''} / audit programme FY ${book.programme.fy}`,
    10,
    regular,
    MUTED,
  );
  w.gap(8);
  if (audit.state === 'CANCELLED') {
    w.paragraph(`Cancelled: ${audit.cancelReason ?? ''}`, 11, bold);
  } else if (audit.reportedOn === null) {
    w.paragraph(
      `Draft: this audit is ${codeWords(audit.state).toLowerCase()} and not yet reported.`,
      11,
      bold,
    );
  }
  line('State', codeWords(audit.state));
  line('Planned', `${audit.plannedStart} to ${audit.plannedEnd}`);
  line('Reported on', audit.reportedOn ?? 'Not yet reported');
  line(
    'Units',
    audit.unitIds.length === 0 ? "The system's units" : audit.unitIds.map(unit).join(', '),
  );
  line('Clauses', clauses(audit.clauseIds));

  w.heading('People');
  line('Lead auditor', person(audit.leadAuditorId));
  line('Auditors', people(audit.auditorIds));
  line('Auditees', people(audit.auditeeIds));
  line('Reported to', people(audit.reportedToIds));

  w.heading('Independence');
  // The contract asks for a note whenever an auditor is an auditee; the table does not, so the lists decide here.
  const self = selfAuditors(audit);
  if (audit.independenceNote !== null) w.paragraph(audit.independenceNote, 10);
  else if (self.length === 0) w.paragraph(NO_SELF_AUDIT, 10);
  else
    w.paragraph(
      `No independence note is recorded, though these auditors are also auditees: ${people(self)}.`,
      10,
      bold,
    );

  w.heading('Summary');
  w.paragraph(
    audit.summary ?? 'No summary yet.',
    10,
    regular,
    audit.summary === null ? MUTED : undefined,
  );

  w.heading('Checklist');
  if (book.checklist.length === 0) w.paragraph('No checklist rows.', 10, regular, MUTED);
  for (const item of book.checklist) {
    w.gap(4);
    const result = item.result === null ? 'Not answered' : codeWords(item.result);
    w.paragraph(
      `${names.clauses.get(item.clauseId) ?? ''} · ${unit(item.unitId)} · ${result}`,
      10,
      bold,
    );
    w.paragraph(item.question, 10);
    if (item.auditorNote !== null)
      w.paragraph(`Auditor's note: ${item.auditorNote}`, 10, regular, MUTED);
    if (item.notAuditedReason !== null) {
      w.paragraph(`Not audited because: ${item.notAuditedReason}`, 10, regular, MUTED);
    }
  }

  w.heading('Findings');
  if (book.findings.length === 0) w.paragraph('No findings.', 10, regular, MUTED);
  book.findings.forEach((finding, i) => {
    w.gap(4);
    const nc =
      finding.nonconformityId === null
        ? ''
        : ` · raised NC ${book.ncNumbers.get(finding.nonconformityId) ?? ''}`;
    w.paragraph(
      `${i + 1}. ${findingTypeWords(finding.type)} · ${unit(finding.unitId)}${nc}`,
      10,
      bold,
    );
    w.paragraph(`Clauses: ${clauses(finding.clauseIds)}`, 10, regular, MUTED);
    w.paragraph(finding.description, 10);
    for (const action of book.actions.filter((a) => a.subject.id === finding.id)) {
      w.paragraph(
        `Improvement action: ${action.text} · ${person(action.ownerId)} · due ${action.dueOn} · ${codeWords(action.state)}`,
        10,
        regular,
        MUTED,
      );
    }
  });

  return doc.save();
}
