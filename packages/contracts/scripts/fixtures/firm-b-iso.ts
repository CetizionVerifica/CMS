// Firm B's ISO add-on data (docs/contracts/fixtures.md §8): Northwind Foods Group's integrated management system.
// The catalogue rows, STANDARD acts and obligations come from `isoCatalogueRows`; this file holds the client's records.
// Every name and figure is invented; text is our own words, never a standard's. Harbour and firm A get no ISO rows.
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { IsoStandardCode } from '../../src/enums.js';
import type { IsoFixtureSet } from '../../src/fixtures/schema.js';
import { fixtureId, isoCatalogueId, isoCatalogueRows } from '../../src/fixtures/index.js';
import { ReviewInputKey, ReviewOutputKey } from '../../src/schemas/iso.js';
import { addDays, periodsIn } from '../../src/mock/periods.js';

type Fixture = z.input<typeof IsoFixtureSet>;
type Rows<K extends keyof Fixture> = Fixture[K] extends (infer T)[] ? T[] : never;
type Row<K extends keyof Fixture> = Rows<K>[number];

/** Firm B (Second Ledger Consulting). */
export const FIRM_B_ID = fixtureId('firm-b');

/** When firm B's catalogue copy was recorded; every ISO record is later. */
const CATALOGUE_COPIED_AT = '2024-04-02T04:30:00Z';

const b = (key: string) => fixtureId(`firm-b:${key}`);
/** The id of one of this file's rows: `fixtureId('firm-b:iso:<key>')`. */
const k = (key: string) => fixtureId(`firm-b:iso:${key}`);
const who = (key: string) => b(`person:${key}`);
const NORTHWIND = b('client:northwind');
const PUNE = b('unit:pune');
const BENGALURU = b('unit:bengaluru');
/** 11:00 in Kolkata. */
const at = (date: string, time = '05:30:00') => `${date}T${time}Z`;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Base fields of a Northwind ISO record, written on `created` and last changed on `updated`. */
function record(key: string, created: string, updated = created, version = 1) {
  return {
    id: k(key),
    firmId: FIRM_B_ID,
    clientId: NORTHWIND,
    createdAt: at(created),
    updatedAt: at(updated),
    archivedAt: null,
    version,
  };
}

export function buildFirmBIso(): Fixture {
  const catalogue = isoCatalogueRows(FIRM_B_ID, CATALOGUE_COPIED_AT);
  const standard = (code: IsoStandardCode) => catalogue.standards.find((s) => s.code === code)!;
  const clause = (code: IsoStandardCode, number: string) => {
    const found = catalogue.clauses.find(
      (c) => c.standardId === standard(code).id && c.number === number,
    );
    if (found === undefined) throw new Error(`No clause ${code} ${number}`);
    return found.id!;
  };
  const Q = (n: string) => clause('ISO_9001', n);
  const E = (n: string) => clause('ISO_14001', n);
  const S = (n: string) => clause('ISO_45001', n);
  const CODES: IsoStandardCode[] = ['ISO_9001', 'ISO_14001', 'ISO_45001'];

  // ---------- management system and context ----------

  const system: Row<'managementSystems'> = {
    ...record('system:ims', '2024-04-10', '2024-07-22', 4),
    name: 'Northwind integrated management system',
    standardIds: CODES.map((c) => standard(c).id!),
    scopeStatement:
      'Baking and packing of biscuits and snacks at the Pune Plant, and sales, purchasing and administration at ' +
      'the Bengaluru Office, for retail and food-service customers in India.',
    unitIds: [PUNE, BENGALURU],
    status: 'CERTIFIED',
    reviewIntervalMonths: 12,
    climateChangeRelevant: true,
    climateChangeRationale:
      'Hotter summers and an irregular monsoon affect wheat supply, cooling loads on the ovens and heat stress on the ' +
      'production floor.',
    climateDecidedOn: '2024-05-06',
  };
  const systemId = system.id!;
  const inSystem = (key: string, created: string, updated = created, version = 1) => ({
    ...record(key, created, updated, version),
    managementSystemId: systemId,
  });

  const contextItems: Rows<'contextItems'> = [
    {
      ...inSystem('context:ovens', '2024-04-15', '2024-05-06', 2),
      kind: 'INTERNAL_ISSUE',
      text: 'The line 2 ovens are ageing: they limit output and use more gas per tonne than line 1.',
      needs: null,
      climateRelated: false,
      reviewedOn: '2024-05-06',
    },
    {
      ...inSystem('context:climate', '2024-04-15', '2024-05-06', 2),
      kind: 'EXTERNAL_ISSUE',
      text: 'Rising summer temperatures and an irregular monsoon disturb wheat supply and raise cooling loads.',
      needs: null,
      climateRelated: true,
      reviewedOn: '2024-05-06',
    },
    {
      ...inSystem('context:packaging', '2024-04-15'),
      kind: 'EXTERNAL_ISSUE',
      text: 'Large retail customers ask for recyclable packaging on every product by 2026.',
      needs: null,
      climateRelated: false,
      reviewedOn: null,
    },
    {
      ...inSystem('context:customers', '2024-04-15', '2024-05-06', 2),
      kind: 'INTERESTED_PARTY',
      text: 'Retail and food-service customers',
      needs:
        'Consistent quality, on-time delivery and allergen labelling that is always right. Contract quality terms ' +
        'become compliance obligations.',
      climateRelated: false,
      reviewedOn: '2024-05-06',
    },
    {
      ...inSystem('context:regulator', '2024-04-15'),
      kind: 'INTERESTED_PARTY',
      text: 'State pollution control board',
      needs:
        'Effluent and air emission limits in the consent to operate are met and reported. These are compliance ' +
        'obligations.',
      climateRelated: false,
      reviewedOn: null,
    },
    {
      ...inSystem('context:workers', '2024-04-15', '2024-05-06', 2),
      kind: 'INTERESTED_PARTY',
      text: 'Employees and contract workers at the Pune Plant',
      needs: 'A safe workplace, and a say in safety decisions through the safety committee.',
      climateRelated: false,
      reviewedOn: '2024-05-06',
    },
  ];

  // ---------- checklist: one row per assessable clause of the three standards ----------

  /** Approved as not applicable: no product design (each clause allows exclusion). */
  const DESIGN = ['8.3.1', '8.3.2', '8.3.3', '8.3.4', '8.3.5', '8.3.6'];
  const NO_DESIGN =
    'Northwind bakes to established recipes and customer specifications; it does no product design or development.';
  const clauseAssessments: Rows<'clauseAssessments'> = [];
  for (const code of CODES) {
    const assessable = catalogue.clauses.filter(
      (c) => c.standardId === standard(code).id && c.assessable,
    );
    for (const c of assessable) {
      const number = c.number;
      const key = `checklist:${code}:${number}`;
      const top = Number(number.split('.')[0]);
      const row: Row<'clauseAssessments'> = {
        ...inSystem(key, '2024-04-10'),
        clauseId: c.id!,
        status: 'NOT_STARTED',
        justification: null,
        naState: 'NONE',
        statusBeforeNa: null,
        naRequestedById: null,
        naDecidedById: null,
        naDecidedAt: null,
        ownerId: null,
        notes: null,
        lastReviewedOn: null,
      };
      // ISO 9001 is certified: implemented, with a few gaps. 14001 and 45001 are on their way.
      const status =
        code === 'ISO_9001'
          ? ['6.3', '7.1.6', '10.3'].includes(number)
            ? 'PARTIAL'
            : 'IMPLEMENTED'
          : top <= 5 || (code === 'ISO_45001' && number.startsWith('6.1'))
            ? 'IMPLEMENTED'
            : top <= 8
              ? 'PARTIAL'
              : 'NOT_STARTED';
      if (status !== 'NOT_STARTED') {
        Object.assign(row, {
          status,
          ownerId: code === 'ISO_9001' || code === 'ISO_14001' ? who('sameer') : who('rohan'),
          lastReviewedOn: code === 'ISO_9001' ? '2024-06-28' : '2024-10-25',
          updatedAt: at(code === 'ISO_9001' ? '2024-06-28' : '2024-10-25'),
          version: 2,
        });
      }
      if (code === 'ISO_9001' && DESIGN.includes(number)) {
        Object.assign(row, {
          status: 'NOT_APPLICABLE',
          justification: NO_DESIGN,
          naState: 'APPROVED',
          statusBeforeNa: 'NOT_STARTED',
          naRequestedById: who('sameer'),
          naDecidedById: who('divya'),
          naDecidedAt: at('2024-05-20', '06:00:00'),
          ownerId: who('sameer'),
          lastReviewedOn: null,
          updatedAt: at('2024-05-20', '06:00:00'),
          version: 3,
        });
      }
      if (code === 'ISO_9001' && number === '8.5.3') {
        Object.assign(row, {
          status: 'NOT_APPLICABLE',
          justification:
            'Customers and suppliers lend Northwind no materials, tooling or data, so there is no outside property to look after.',
          naState: 'REQUESTED',
          statusBeforeNa: 'NOT_STARTED',
          naRequestedById: who('sameer'),
          ownerId: who('sameer'),
          lastReviewedOn: null,
          updatedAt: at('2024-11-12'),
          version: 2,
        });
      }
      if (code === 'ISO_9001' && number === '8.5.5') {
        // Rejected: the status before the request is back, and the requester's reason stays on the row.
        Object.assign(row, {
          status: 'PARTIAL',
          justification:
            'Products are sold through retailers, so Northwind has no post-delivery work.',
          naState: 'REJECTED',
          naRequestedById: who('sameer'),
          naDecidedById: who('divya'),
          naDecidedAt: at('2024-06-03', '07:00:00'),
          ownerId: who('sameer'),
          notes: 'Recalls, complaint handling and shelf-life follow-up are post-delivery work.',
          updatedAt: at('2024-06-03', '07:00:00'),
          version: 4,
        });
      }
      if (code === 'ISO_9001' && number === '6.3') {
        row.notes = 'Changes to the system are planned informally at the Bengaluru Office.';
      }
      clauseAssessments.push(row);
    }
  }

  // ---------- documents and revisions ----------

  const documents: Rows<'documents'> = [];
  const revisions: Rows<'revisions'> = [];
  const files: Rows<'files'> = [];

  type Subject = keyof typeof SUBJECT_COLUMN;
  const SUBJECT_COLUMN = {
    document_revision: 'documentRevisionId',
    risk_item: 'riskItemId',
    internal_audit: 'internalAuditId',
    external_audit: 'externalAuditId',
    certification: 'certificationId',
    nonconformity: 'nonconformityId',
    clause_assessment: 'clauseAssessmentId',
    objective_reading: 'objectiveReadingId',
    audit_finding: 'auditFindingId',
    iso_action: 'isoActionId',
    management_review: 'managementReviewId',
  } as const;
  const addFile = (
    key: string,
    subject: Subject,
    subjectId: string,
    fileName: string,
    uploadedBy: string,
    uploadedOn: string,
    scanStatus: Row<'files'>['scanStatus'] = 'CLEAN',
    removed: { on: string; reason: string } | null = null,
  ) => {
    const id = k(`file:${key}`);
    const uploadedAt = at(uploadedOn, '04:45:00');
    files.push({
      id,
      firmId: FIRM_B_ID,
      clientId: NORTHWIND,
      createdAt: uploadedAt,
      updatedAt: removed === null ? uploadedAt : at(removed.on),
      archivedAt: removed === null ? null : at(removed.on),
      fileName,
      mimeType: fileName.endsWith('.pdf') ? 'application/pdf' : 'image/png',
      sizeBytes: 120_000 + files.length * 7_000,
      sha256: sha256(`${id}:${fileName}`),
      scanStatus,
      uploadedById: who(uploadedBy),
      uploadedAt,
      removeReason: removed?.reason ?? null,
      ...Object.fromEntries(
        Object.values(SUBJECT_COLUMN).map((column) => [
          column,
          column === SUBJECT_COLUMN[subject] ? subjectId : null,
        ]),
      ),
      storageKey: `evidence/${FIRM_B_ID}/${NORTHWIND}/iso/${subject}/${subjectId}/${id}`,
    } as Row<'files'>);
  };

  interface RevisionSpec {
    revision: string;
    state: Row<'revisions'>['state'];
    preparedBy: string;
    drafted: string;
    /** APPROVED and SUPERSEDED: the day it was approved (or its edition recorded). */
    approved?: string;
    /** Approver, or null for an external edition. */
    approvedBy?: string | null;
    changeNote: string | null;
    sendBackReason?: string;
    /** The revision's file, if one is uploaded; PENDING while the scan runs. */
    file?: { name: string; scan?: Row<'files'>['scanStatus']; on?: string };
    updated?: string;
    version?: number;
  }
  const addDocument = (
    code: string,
    doc: Omit<
      Row<'documents'>,
      | 'id'
      | 'firmId'
      | 'clientId'
      | 'createdAt'
      | 'updatedAt'
      | 'archivedAt'
      | 'version'
      | 'managementSystemId'
      | 'code'
      | 'currentRevisionId'
    > & { created: string; updated: string; version: number },
    specs: RevisionSpec[],
  ) => {
    const { created, updated, version, ...fields } = doc;
    const revisionIds = specs.map((s) => k(`revision:${code}:${s.revision}`));
    const current = specs.findIndex((s) => s.state === 'APPROVED');
    documents.push({
      ...inSystem(`document:${code}`, created, updated, version),
      code,
      ...fields,
      currentRevisionId: current < 0 ? null : revisionIds[current]!,
    });
    specs.forEach((s, i) => {
      const approved = s.approved === undefined ? null : at(s.approved, '09:00:00');
      revisions.push({
        ...record(
          `revision:${code}:${s.revision}`,
          s.drafted,
          s.updated ?? s.approved ?? s.drafted,
          s.version ?? (s.state === 'DRAFT' ? 1 : s.state === 'SUPERSEDED' ? 4 : 3),
        ),
        documentId: k(`document:${code}`),
        revision: s.revision,
        changeNote: s.changeNote,
        state: s.state,
        preparedById: who(s.preparedBy),
        approvedById: approved === null || s.approvedBy == null ? null : who(s.approvedBy),
        approvedAt: approved,
        sendBackReason: s.sendBackReason ?? null,
      });
      if (s.file !== undefined) {
        addFile(
          `revision:${code}:${s.revision}`,
          'document_revision',
          revisionIds[i]!,
          s.file.name,
          s.preparedBy,
          s.file.on ?? s.drafted,
          s.file.scan ?? 'CLEAN',
        );
      }
    });
  };

  // An ACTIVE policy whose approved revision is linked to clause 5.2 of each standard, with the one it replaced.
  addDocument(
    'NFG-POL-01',
    {
      title: 'Quality, environment and health and safety policy',
      type: 'POLICY',
      clauseIds: [Q('5.2.1'), Q('5.2.2'), E('5.2'), S('5.2')],
      status: 'ACTIVE',
      ownerId: who('kabir'),
      approverId: who('divya'),
      reviewDueOn: '2025-09-02',
      lastReviewedOn: '2024-09-02',
      retention: null,
      issuer: null,
      externalRef: null,
      created: '2024-04-12',
      updated: '2024-09-02',
      version: 3,
    },
    [
      {
        revision: 'A',
        state: 'SUPERSEDED',
        preparedBy: 'kabir',
        drafted: '2024-04-12',
        approved: '2024-04-20',
        approvedBy: 'divya',
        updated: '2024-09-02',
        changeNote: 'First issue of the integrated policy.',
        file: { name: 'integrated-policy-rev-a.pdf' },
      },
      {
        revision: 'B',
        state: 'APPROVED',
        preparedBy: 'kabir',
        drafted: '2024-08-26',
        approved: '2024-09-02',
        approvedBy: 'divya',
        changeNote: 'Adds the commitment to consult workers and to act on climate risks.',
        file: { name: 'integrated-policy-rev-b.pdf' },
      },
    ],
  );
  // A manual whose next revision waits for its approver.
  addDocument(
    'NFG-QM-01',
    {
      title: 'Integrated management system manual',
      type: 'MANUAL',
      clauseIds: [Q('4.3'), E('4.3'), S('4.3'), Q('4.4.1')],
      status: 'ACTIVE',
      ownerId: who('sameer'),
      approverId: who('divya'),
      reviewDueOn: '2025-05-10',
      lastReviewedOn: '2024-05-10',
      retention: null,
      issuer: null,
      externalRef: null,
      created: '2024-04-18',
      updated: '2024-11-08',
      version: 2,
    },
    [
      {
        revision: '1.0',
        state: 'APPROVED',
        preparedBy: 'sameer',
        drafted: '2024-04-18',
        approved: '2024-05-10',
        approvedBy: 'divya',
        changeNote: 'First issue.',
        file: { name: 'ims-manual-1-0.pdf' },
      },
      {
        revision: '2.0',
        state: 'IN_REVIEW',
        preparedBy: 'sameer',
        drafted: '2024-11-04',
        updated: '2024-11-08',
        version: 2,
        changeNote: 'Adds the Bengaluru Office to the scope and the new audit programme.',
        file: { name: 'ims-manual-2-0.pdf', on: '2024-11-07' },
      },
    ],
  );
  // A procedure whose draft came back from its approver, with a new file still being scanned.
  addDocument(
    'NFG-PR-07',
    {
      title: 'Control of nonconforming product',
      type: 'PROCEDURE',
      clauseIds: [Q('8.7.1'), Q('8.7.2'), Q('10.2.1')],
      status: 'ACTIVE',
      ownerId: who('rohan'),
      approverId: who('nisha'),
      reviewDueOn: '2025-06-05',
      lastReviewedOn: '2024-06-05',
      retention: null,
      issuer: null,
      externalRef: null,
      created: '2024-05-27',
      updated: '2024-11-12',
      version: 2,
    },
    [
      {
        revision: 'A',
        state: 'APPROVED',
        preparedBy: 'rohan',
        drafted: '2024-05-27',
        approved: '2024-06-05',
        approvedBy: 'nisha',
        changeNote: 'First issue.',
        file: { name: 'nonconforming-product-rev-a.pdf' },
      },
      {
        revision: 'B',
        state: 'DRAFT',
        preparedBy: 'rohan',
        drafted: '2024-11-04',
        updated: '2024-11-12',
        version: 3,
        changeNote: 'Adds the hold tag for pallets in quarantine.',
        sendBackReason: 'Say who may release a pallet from quarantine.',
        file: { name: 'nonconforming-product-rev-b-2.pdf', scan: 'PENDING', on: '2024-11-14' },
      },
    ],
  );
  // The file it was submitted with, removed after the send-back: a revision has one live file.
  addFile(
    'revision:NFG-PR-07:B:first',
    'document_revision',
    k('revision:NFG-PR-07:B'),
    'nonconforming-product-rev-b.pdf',
    'rohan',
    '2024-11-05',
    'CLEAN',
    { on: '2024-11-13', reason: 'Replaced after the approver sent the revision back.' },
  );
  // A form with its retention rule.
  addDocument(
    'NFG-FRM-03',
    {
      title: 'Oven temperature log',
      type: 'FORM',
      clauseIds: [Q('8.5.1'), Q('7.5.3.2')],
      status: 'ACTIVE',
      ownerId: who('rohan'),
      approverId: who('nisha'),
      reviewDueOn: '2025-05-20',
      lastReviewedOn: '2024-05-20',
      retention: 'Kept for three years in the production office, then shredded.',
      issuer: null,
      externalRef: null,
      created: '2024-05-14',
      updated: '2024-05-20',
      version: 2,
    },
    [
      {
        revision: '1',
        state: 'APPROVED',
        preparedBy: 'rohan',
        drafted: '2024-05-14',
        approved: '2024-05-20',
        approvedBy: 'nisha',
        changeNote: 'First issue.',
        file: { name: 'oven-temperature-log-1.pdf' },
      },
    ],
  );
  // An external document: its edition is recorded, with no internal approver.
  addDocument(
    'NFG-EXT-01',
    {
      title: 'Specification for bakery-grade wheat flour',
      type: 'EXTERNAL',
      clauseIds: [Q('8.4.3')],
      status: 'ACTIVE',
      ownerId: who('sameer'),
      approverId: who('divya'),
      reviewDueOn: '2025-06-18',
      lastReviewedOn: null,
      retention: null,
      issuer: 'Western Grain Traders',
      externalRef: 'WGT-SPEC-112',
      created: '2024-06-14',
      updated: '2024-06-18',
      version: 2,
    },
    [
      {
        revision: '4',
        state: 'APPROVED',
        preparedBy: 'sameer',
        drafted: '2024-06-14',
        approved: '2024-06-18',
        approvedBy: null,
        version: 2,
        changeNote: 'Edition 4 from the supplier.',
        file: { name: 'flour-specification-edition-4.pdf' },
      },
    ],
  );
  // A work instruction made obsolete when the manual mixer went; its revision stays readable as history.
  addDocument(
    'NFG-WI-02',
    {
      title: 'Cleaning the manual dough mixer',
      type: 'WORK_INSTRUCTION',
      clauseIds: [Q('8.5.1')],
      status: 'OBSOLETE',
      ownerId: who('rohan'),
      approverId: who('nisha'),
      reviewDueOn: '2025-04-25',
      lastReviewedOn: null,
      retention: null,
      issuer: null,
      externalRef: null,
      created: '2024-04-22',
      updated: '2024-10-14',
      version: 3,
    },
    [
      {
        revision: 'A',
        state: 'APPROVED',
        preparedBy: 'rohan',
        drafted: '2024-04-22',
        approved: '2024-04-25',
        approvedBy: 'nisha',
        changeNote: 'First issue.',
        file: { name: 'mixer-cleaning-rev-a.pdf' },
      },
    ],
  );

  // ---------- risks, controls and treatment actions ----------

  const RULE = { significantAt: 12, legalLinkMakesSignificant: true };
  const obligation = (code: string) => b(`obligation:${code}`);
  const riskItems: Rows<'riskItems'> = [];
  type RiskSpec = Omit<
    Row<'riskItems'>,
    | 'id'
    | 'firmId'
    | 'clientId'
    | 'createdAt'
    | 'updatedAt'
    | 'archivedAt'
    | 'version'
    | 'managementSystemId'
    | 'rating'
    | 'residualRating'
    | 'significant'
    | 'lifeCycleStages'
    | 'controlType'
    | 'routine'
    | 'personsExposed'
    | 'condition'
    | 'assessedWith'
    | 'impact'
    | 'residualLikelihood'
    | 'residualSeverity'
    | 'significantOverride'
    | 'significanceReason'
    | 'obligationIds'
    | 'climateRelated'
  > &
    Partial<Row<'riskItems'>> & { created: string; updated?: string; version?: number };
  const addRisk = (key: string, spec: RiskSpec) => {
    const { created, updated, version, ...fields } = spec;
    const item = {
      ...inSystem(`risk:${key}`, created, updated ?? created, version ?? 1),
      impact: null,
      lifeCycleStages: [],
      controlType: null,
      routine: null,
      personsExposed: [],
      condition: null,
      assessedWith: null,
      residualLikelihood: null,
      residualSeverity: null,
      significantOverride: null,
      significanceReason: null,
      obligationIds: [],
      climateRelated: false,
      ...fields,
    };
    const rating = item.likelihood * item.severity;
    const significant =
      item.significantOverride ??
      (rating >= RULE.significantAt ||
        (RULE.legalLinkMakesSignificant && item.obligationIds.length > 0));
    riskItems.push({
      ...item,
      rating,
      residualRating:
        item.residualLikelihood === null || item.residualSeverity === null
          ? null
          : item.residualLikelihood * item.residualSeverity,
      significant,
    });
    return k(`risk:${key}`);
  };

  const riskFlour = addRisk('flour-supply', {
    kind: 'RISK',
    unitId: PUNE,
    activity: 'Buying flour',
    description:
      'All bakery-grade flour comes from one supplier; a failed delivery stops both lines.',
    likelihood: 3,
    severity: 4,
    residualLikelihood: 2,
    residualSeverity: 4,
    ownerId: who('sameer'),
    reviewDueOn: '2025-05-14',
    lastReviewedOn: '2024-05-14',
    created: '2024-05-14',
  });
  addRisk('climate', {
    kind: 'RISK',
    unitId: null,
    activity: 'Sourcing and production',
    description: 'Heat waves and a late monsoon cut wheat quality and push up cooling costs.',
    likelihood: 3,
    severity: 3,
    climateRelated: true,
    ownerId: who('kabir'),
    reviewDueOn: '2025-05-14',
    lastReviewedOn: '2024-05-14',
    created: '2024-05-14',
  });
  const riskSolar = addRisk('solar', {
    kind: 'OPPORTUNITY',
    unitId: PUNE,
    activity: 'Energy',
    description: 'Rooftop solar at the Pune Plant would cut grid electricity and its cost.',
    likelihood: 3,
    severity: 3,
    ownerId: who('rohan'),
    reviewDueOn: '2025-05-14',
    lastReviewedOn: '2024-05-14',
    created: '2024-05-14',
  });
  const riskEffluent = addRisk('effluent', {
    kind: 'ASPECT',
    unitId: PUNE,
    activity: 'Washing trays and mixers',
    description: 'Wash water carries fat and dough to the drain.',
    impact: 'Organic load in the effluent sent to the municipal drain.',
    lifeCycleStages: ['PRODUCTION'],
    controlType: 'CONTROL',
    condition: 'NORMAL',
    likelihood: 3,
    severity: 3,
    // Significant by decision, though its rating is below the threshold.
    significantOverride: true,
    significanceReason:
      'The consent to operate sets effluent limits, so the board treats it as significant.',
    ownerId: who('rohan'),
    reviewDueOn: '2025-05-21',
    lastReviewedOn: '2024-05-21',
    created: '2024-05-21',
    updated: '2024-05-28',
    version: 2,
  });
  const riskPackaging = addRisk('packaging-waste', {
    kind: 'ASPECT',
    unitId: PUNE,
    activity: 'Packing',
    description: 'Rejected packs and offcuts of laminated film go to landfill.',
    impact: 'Plastic waste to landfill.',
    lifeCycleStages: ['PRODUCTION', 'END_OF_LIFE'],
    controlType: 'INFLUENCE',
    condition: 'NORMAL',
    likelihood: 2,
    severity: 2,
    ownerId: who('rohan'),
    // Due for review and not yet reviewed.
    reviewDueOn: '2024-10-31',
    lastReviewedOn: null,
    created: '2024-05-21',
  });
  const riskOven = addRisk('oven-burns', {
    kind: 'HAZARD',
    unitId: PUNE,
    activity: 'Changing oven trays on line 2',
    description: 'Hot trays and oven doors are handled during each tray change.',
    impact: 'Burns to hands and forearms.',
    routine: true,
    personsExposed: ['WORKER', 'CONTRACTOR'],
    condition: 'NORMAL',
    assessedWith: 'Two line 2 oven operators and the shift supervisor.',
    likelihood: 3,
    severity: 4,
    residualLikelihood: 2,
    residualSeverity: 3,
    // Linked to the accident notice and the safety committee: significant by the legal-link rule too.
    obligationIds: [obligation('SLC-EHS-012'), obligation('SLC-EHS-010')],
    ownerId: who('rohan'),
    reviewDueOn: '2025-09-20',
    lastReviewedOn: '2024-09-20',
    created: '2024-05-21',
    updated: '2024-09-20',
    version: 3,
  });
  const riskScreens = addRisk('screen-work', {
    kind: 'HAZARD',
    unitId: BENGALURU,
    activity: 'Office work',
    description: 'Long hours at screens without breaks or adjustable seating.',
    impact: 'Neck, back and eye strain.',
    routine: true,
    personsExposed: ['WORKER'],
    condition: 'NORMAL',
    assessedWith: 'Two members of the sales team.',
    likelihood: 3,
    severity: 2,
    ownerId: who('sameer'),
    reviewDueOn: '2025-06-10',
    lastReviewedOn: '2024-06-10',
    created: '2024-06-10',
  });

  // ---------- objectives and readings ----------

  const QUARTERLY = { kind: 'QUARTERLY', anchor: 'PERIOD_END', days: 0 } as const;
  const objectives: Rows<'objectives'> = [
    {
      // On track: the latest reading is below the straight line from the baseline to the target.
      ...inSystem('objective:energy', '2024-04-15', '2024-10-08', 3),
      standards: ['ISO_14001'],
      text: 'Cut grid electricity per tonne of product at the Pune Plant',
      target: 380,
      unitOfMeasure: 'kWh per tonne',
      baseline: 420,
      direction: 'DECREASE',
      readingRule: QUARTERLY,
      riskItemIds: [riskSolar],
      ownerId: who('rohan'),
      dueOn: '2025-03-31',
      closedOn: null,
      outcome: null,
    },
    {
      // Off track: complaints went up in the second quarter.
      ...inSystem('objective:complaints', '2024-04-15', '2024-10-09', 3),
      standards: ['ISO_9001'],
      text: 'Bring customer complaints down to five a quarter',
      target: 5,
      unitOfMeasure: 'complaints per quarter',
      baseline: 12,
      direction: 'DECREASE',
      readingRule: QUARTERLY,
      riskItemIds: [],
      ownerId: who('sameer'),
      dueOn: '2025-03-31',
      closedOn: null,
      outcome: null,
    },
    {
      // Closed early, achieved.
      ...inSystem('objective:oven-training', '2024-04-15', '2024-10-04', 4),
      standards: ['ISO_45001'],
      text: 'Train every line 2 operator in safe oven handling',
      target: 100,
      unitOfMeasure: '% of operators trained',
      baseline: 40,
      direction: 'INCREASE',
      readingRule: QUARTERLY,
      riskItemIds: [riskOven],
      ownerId: who('rohan'),
      dueOn: '2024-12-31',
      closedOn: '2024-10-04',
      outcome: 'ACHIEVED',
    },
  ];
  const reading = (
    objective: string,
    periodStart: string,
    periodEnd: string,
    value: number,
    by: string,
    recorded: string,
    note: string | null = null,
  ): Row<'readings'> => ({
    ...record(`reading:${objective}:${periodStart}`, recorded),
    objectiveId: k(`objective:${objective}`),
    periodStart,
    periodEnd,
    value,
    note,
    recordedById: who(by),
  });
  const readings: Rows<'readings'> = [
    reading('energy', '2024-04-01', '2024-06-30', 412, 'rohan', '2024-07-08'),
    reading(
      'energy',
      '2024-07-01',
      '2024-09-30',
      395,
      'rohan',
      '2024-10-08',
      'Line 1 heat recovery came on in August.',
    ),
    reading('complaints', '2024-04-01', '2024-06-30', 11, 'sameer', '2024-07-09'),
    reading(
      'complaints',
      '2024-07-01',
      '2024-09-30',
      13,
      'sameer',
      '2024-10-09',
      'Four complaints were about loose seals on one carton size.',
    ),
    reading('oven-training', '2024-04-01', '2024-06-30', 70, 'rohan', '2024-07-05'),
    reading('oven-training', '2024-07-01', '2024-09-30', 100, 'rohan', '2024-10-04'),
  ];

  // ---------- internal audits ----------

  const programmeId = k('programme:2024-25');
  const auditProgrammes: Rows<'auditProgrammes'> = [
    {
      ...inSystem('programme:2024-25', '2024-04-20'),
      fy: '2024-25',
      notes: 'One audit a quarter, so every clause and both units are covered in the year.',
    },
  ];
  const internalAudits: Rows<'internalAudits'> = [];
  const auditChecklistItems: Rows<'auditChecklistItems'> = [];
  const findings: Rows<'findings'> = [];
  type AuditSpec = Omit<
    Row<'internalAudits'>,
    | 'id'
    | 'firmId'
    | 'clientId'
    | 'createdAt'
    | 'updatedAt'
    | 'archivedAt'
    | 'version'
    | 'programmeId'
    | 'independenceNote'
    | 'summary'
    | 'reportedOn'
    | 'cancelReason'
    | 'auditorIds'
    | 'reportedToIds'
  > &
    Partial<Row<'internalAudits'>> & { created: string; updated: string; version: number };
  const addAudit = (key: string, spec: AuditSpec) => {
    const { created, updated, version, ...fields } = spec;
    internalAudits.push({
      ...record(`audit:${key}`, created, updated, version),
      programmeId,
      auditorIds: [],
      reportedToIds: [],
      independenceNote: null,
      summary: null,
      reportedOn: null,
      cancelReason: null,
      ...fields,
    });
    return k(`audit:${key}`);
  };
  const addChecklistRow = (
    auditKey: string,
    n: number,
    clauseId: string,
    unitId: string | null,
    question: string,
    answer: Partial<Row<'auditChecklistItems'>> = {},
    on = '2024-04-20',
  ) => {
    auditChecklistItems.push({
      ...record(`audit:${auditKey}:item:${n}`, on, on, answer.result == null ? 1 : 2),
      internalAuditId: k(`audit:${auditKey}`),
      clauseId,
      unitId,
      question,
      auditorNote: null,
      result: null,
      findingId: null,
      notAuditedReason: null,
      ...answer,
    });
  };
  type FindingSpec = Pick<Row<'findings'>, 'type' | 'clauseIds' | 'unitId' | 'description'> & {
    on: string;
    nc?: string;
  };
  const addFinding = (
    key: string,
    parent: { internal?: string; external?: string },
    f: FindingSpec,
  ) => {
    findings.push({
      ...record(`finding:${key}`, f.on),
      internalAuditId: parent.internal === undefined ? null : k(`audit:${parent.internal}`),
      externalAuditId: parent.external === undefined ? null : k(`external:${parent.external}`),
      type: f.type,
      clauseIds: f.clauseIds,
      unitId: f.unitId,
      description: f.description,
      nonconformityId: f.nc === undefined ? null : k(`nc:${f.nc}`),
    });
    return k(`finding:${key}`);
  };

  // Q1, CLOSED: quality at the Pune Plant.
  addAudit('q1-quality', {
    title: 'Q1 internal audit: purchasing and production at the Pune Plant',
    plannedStart: '2024-06-10',
    plannedEnd: '2024-06-12',
    clauseIds: [Q('8.4.1'), Q('8.5.1'), Q('8.7.1')],
    unitIds: [PUNE],
    leadAuditorId: who('sameer'),
    auditeeIds: [who('rohan')],
    reportedToIds: [who('kabir')],
    state: 'CLOSED',
    summary:
      'Purchasing and production controls work; supplier re-evaluations are sometimes signed late.',
    reportedOn: '2024-06-14',
    created: '2024-04-20',
    updated: '2024-07-20',
    version: 5,
  });
  const lateSignatures = addFinding(
    'q1-late-signatures',
    { internal: 'q1-quality' },
    {
      type: 'OBSERVATION',
      clauseIds: [Q('8.4.1')],
      unitId: PUNE,
      description: 'Two supplier re-evaluations were signed after their due date.',
      on: '2024-06-12',
    },
  );
  addFinding(
    'q1-visual-standards',
    { internal: 'q1-quality' },
    {
      type: 'GOOD_PRACTICE',
      clauseIds: [Q('8.5.1')],
      unitId: PUNE,
      description:
        'Line-side boards show the oven settings for each product, so a check takes seconds.',
      on: '2024-06-12',
    },
  );
  addChecklistRow(
    'q1-quality',
    1,
    Q('8.4.1'),
    PUNE,
    'Are suppliers evaluated and re-evaluated on time?',
    { result: 'FINDING', findingId: lateSignatures, auditorNote: 'Sampled 12 suppliers.' },
    '2024-06-03',
  );
  addChecklistRow(
    'q1-quality',
    2,
    Q('8.5.1'),
    PUNE,
    'Are oven settings controlled for each product?',
    { result: 'CONFORMS', auditorNote: 'See the good practice finding.' },
    '2024-06-03',
  );
  addChecklistRow(
    'q1-quality',
    3,
    Q('8.7.1'),
    PUNE,
    'Is nonconforming product held and marked?',
    { result: 'CONFORMS' },
    '2024-06-03',
  );

  // Q2, REPORTED: environment and health and safety at the Pune Plant, with a minor NC and an improvement.
  addAudit('q2-ehs', {
    title: 'Q2 internal audit: environment and health and safety at the Pune Plant',
    plannedStart: '2024-09-16',
    plannedEnd: '2024-09-18',
    clauseIds: [E('6.1.2'), E('8.1'), S('8.1.2'), S('9.1.1'), E('8.2')],
    unitIds: [PUNE],
    leadAuditorId: who('sameer'),
    auditorIds: [who('divya')],
    auditeeIds: [who('rohan'), who('nisha')],
    reportedToIds: [who('kabir')],
    state: 'REPORTED',
    summary:
      'Aspects and operational controls are in place. Tray changes on line 2 do not follow the hierarchy of ' +
      'controls; water use is not metered by line.',
    reportedOn: '2024-09-20',
    created: '2024-04-20',
    updated: '2024-09-20',
    version: 4,
  });
  const trayFinding = addFinding(
    'q2-tray-change',
    { internal: 'q2-ehs' },
    {
      type: 'MINOR_NC',
      clauseIds: [S('8.1.2')],
      unitId: PUNE,
      description:
        'Line 2 tray changes rely on gloves alone; no engineering control was considered.',
      on: '2024-09-18',
      nc: 'tray-change',
    },
  );
  const waterFinding = addFinding(
    'q2-water-metering',
    { internal: 'q2-ehs' },
    {
      type: 'OFI',
      clauseIds: [E('8.1')],
      unitId: PUNE,
      description: 'Metering water by line would show where washing uses the most.',
      on: '2024-09-18',
    },
  );
  addChecklistRow(
    'q2-ehs',
    1,
    E('6.1.2'),
    PUNE,
    'Are aspects reviewed after each change?',
    {
      result: 'CONFORMS',
    },
    '2024-09-10',
  );
  addChecklistRow(
    'q2-ehs',
    2,
    E('8.1'),
    PUNE,
    'Are washing operations controlled?',
    {
      result: 'FINDING',
      findingId: waterFinding,
    },
    '2024-09-10',
  );
  addChecklistRow(
    'q2-ehs',
    3,
    S('8.1.2'),
    PUNE,
    'Were controls chosen by the hierarchy?',
    {
      result: 'FINDING',
      findingId: trayFinding,
    },
    '2024-09-10',
  );
  addChecklistRow(
    'q2-ehs',
    4,
    S('9.1.1'),
    PUNE,
    'Are workplace inspections done and followed up?',
    {
      result: 'CONFORMS',
    },
    '2024-09-10',
  );
  addChecklistRow(
    'q2-ehs',
    5,
    E('8.2'),
    PUNE,
    'Was the last drill evaluated?',
    {
      result: 'NOT_AUDITED',
      notAuditedReason: 'The drill report was still with the safety committee.',
    },
    '2024-09-10',
  );

  // Q3, IN_PROGRESS at the Bengaluru Office: one row answered, one not, one still to add.
  addAudit('q3-office', {
    title: 'Q3 internal audit: competence and records at the Bengaluru Office',
    plannedStart: '2024-11-12',
    plannedEnd: '2024-11-19',
    clauseIds: [Q('7.2'), Q('7.5.3.1'), S('7.2')],
    unitIds: [BENGALURU],
    leadAuditorId: who('arjun'),
    auditeeIds: [who('sameer')],
    reportedToIds: [who('kabir')],
    state: 'IN_PROGRESS',
    created: '2024-04-20',
    updated: '2024-11-12',
    version: 3,
  });
  addChecklistRow(
    'q3-office',
    1,
    Q('7.2'),
    BENGALURU,
    'Is the training matrix up to date?',
    {
      result: 'CONFORMS',
    },
    '2024-11-12',
  );
  addChecklistRow(
    'q3-office',
    2,
    Q('7.5.3.1'),
    BENGALURU,
    'Are records protected from loss?',
    {},
    '2024-11-12',
  );

  // Q4, PLANNED: an auditor who is also an auditee, so it carries an independence note.
  addAudit('q4-system', {
    title: 'Q4 internal audit: performance evaluation and improvement, both units',
    plannedStart: '2025-02-10',
    plannedEnd: '2025-02-14',
    clauseIds: [Q('9.1.3'), E('9.1.2'), S('9.1.2'), Q('10.2.1')],
    unitIds: [PUNE, BENGALURU],
    leadAuditorId: who('sameer'),
    auditorIds: [who('divya')],
    auditeeIds: [who('divya'), who('kabir')],
    independenceNote:
      'Divya audits the Pune Plant only; her own approvals at the Bengaluru Office are audited by Sameer.',
    state: 'PLANNED',
    created: '2024-04-20',
    updated: '2024-10-21',
    version: 2,
  });

  // CANCELLED.
  addAudit('cold-store', {
    title: 'Special audit of the cold store',
    plannedStart: '2024-08-05',
    plannedEnd: '2024-08-05',
    clauseIds: [Q('7.1.4')],
    unitIds: [PUNE],
    leadAuditorId: who('sameer'),
    auditeeIds: [who('rohan')],
    state: 'CANCELLED',
    cancelReason: 'The cold store was taken out of use before the audit.',
    created: '2024-07-01',
    updated: '2024-07-30',
    version: 2,
  });

  // ---------- certification and external audits ----------

  const BODY = 'Tidewater Certification Ltd';
  const certifications: Rows<'certifications'> = [
    {
      ...inSystem('certification:9001', '2024-07-22', '2024-07-22'),
      standardId: standard('ISO_9001').id!,
      body: BODY,
      certificateNumber: 'TCL-QMS-24-0187',
      issuedOn: '2024-07-22',
      expiresOn: '2027-07-21',
      scopeText: null,
      unitIds: [],
    },
    {
      // Applied for; not issued yet.
      ...inSystem('certification:14001', '2024-10-01', '2024-10-01'),
      standardId: standard('ISO_14001').id!,
      body: BODY,
      certificateNumber: null,
      issuedOn: null,
      expiresOn: null,
      scopeText: 'Baking and packing of biscuits and snacks at the Pune Plant.',
      unitIds: [PUNE],
    },
  ];
  addFile(
    'certification:9001',
    'certification',
    k('certification:9001'),
    'iso-9001-certificate.pdf',
    'kabir',
    '2024-07-23',
  );

  const externalAudits: Rows<'externalAudits'> = [
    {
      // Stage 2 for 9001: a minor NC answered, then closed with the certificate.
      ...inSystem('external:stage-2', '2024-05-30', '2024-07-22', 4),
      standardIds: [standard('ISO_9001').id!],
      type: 'STAGE_2',
      body: BODY,
      leadAuditorName: 'Kiran Mehta',
      startOn: '2024-07-01',
      endOn: '2024-07-03',
      recommendation: 'RECOMMENDED_AFTER_CLOSURE',
      responseDueOn: '2024-07-31',
      state: 'CLOSED',
      cancelReason: null,
    },
    {
      // Integrated stage 1 for 14001 and 45001: held, the response not yet sent.
      ...inSystem('external:stage-1-ehs', '2024-09-23', '2024-11-05', 2),
      standardIds: [standard('ISO_14001').id!, standard('ISO_45001').id!],
      type: 'STAGE_1',
      body: BODY,
      leadAuditorName: 'Kiran Mehta',
      startOn: '2024-11-04',
      endOn: '2024-11-05',
      recommendation: null,
      responseDueOn: '2024-12-04',
      state: 'HELD',
      cancelReason: null,
    },
    {
      ...inSystem('external:surveillance-1', '2024-07-22'),
      standardIds: [standard('ISO_9001').id!],
      type: 'SURVEILLANCE_1',
      body: BODY,
      leadAuditorName: null,
      startOn: '2025-07-07',
      endOn: '2025-07-08',
      recommendation: null,
      responseDueOn: null,
      state: 'PLANNED',
      cancelReason: null,
    },
  ];
  addFile(
    'external:stage-2',
    'external_audit',
    k('external:stage-2'),
    'stage-2-audit-report.pdf',
    'kabir',
    '2024-07-04',
  );
  addFile(
    'external:stage-1-ehs',
    'external_audit',
    k('external:stage-1-ehs'),
    'stage-1-audit-report.pdf',
    'kabir',
    '2024-11-05',
  );

  addFinding(
    'stage-2-calibration',
    { external: 'stage-2' },
    {
      type: 'MINOR_NC',
      clauseIds: [Q('7.1.5.1')],
      unitId: PUNE,
      description: 'Calibration records for two packing-line scales could not be found.',
      on: '2024-07-03',
      nc: 'calibration-records',
    },
  );
  const trendFinding = addFinding(
    'stage-2-trends',
    { external: 'stage-2' },
    {
      type: 'OFI',
      clauseIds: [Q('9.1.3')],
      unitId: null,
      description: 'Complaint data could be trended by product line.',
      on: '2024-07-03',
    },
  );
  addFinding(
    'stage-1-consultation',
    { external: 'stage-1-ehs' },
    {
      type: 'MINOR_NC',
      clauseIds: [S('5.4')],
      unitId: PUNE,
      description: 'Contract workers were not invited to the last two safety committee meetings.',
      on: '2024-11-05',
      nc: 'worker-consultation',
    },
  );
  addFinding(
    'stage-1-legal-register',
    { external: 'stage-1-ehs' },
    {
      type: 'OBSERVATION',
      clauseIds: [E('6.1.3')],
      unitId: null,
      description: 'The list of compliance obligations does not yet name the consent to operate.',
      on: '2024-11-05',
    },
  );

  // ---------- nonconformities ----------

  const nonconformities: Rows<'nonconformities'> = [];
  type NcSpec = Omit<
    Row<'nonconformities'>,
    | 'id'
    | 'firmId'
    | 'clientId'
    | 'createdAt'
    | 'updatedAt'
    | 'archivedAt'
    | 'version'
    | 'managementSystemId'
    | 'number'
    | 'sourceInstanceId'
    | 'raisedFromRiskItemId'
    | 'containment'
    | 'correction'
    | 'disposition'
    | 'dispositionAuthorisedById'
    | 'rootCauseMethod'
    | 'rootCause'
    | 'similarOccurrences'
    | 'relatedRiskItemIds'
    | 'updatedRiskItemIds'
    | 'riskReview'
    | 'systemChange'
    | 'changedDocumentIds'
    | 'noActionReason'
    | 'effectivenessDueOn'
    | 'effectivenessNote'
    | 'effective'
    | 'closedOn'
    | 'cancelReason'
    | 'incident'
  > &
    Partial<Row<'nonconformities'>> & { updated: string; version: number };
  const addNc = (key: string, spec: NcSpec) => {
    const { updated, version, ...fields } = spec;
    nonconformities.push({
      ...inSystem(`nc:${key}`, fields.reportedOn, updated, version),
      number: nonconformities.length + 1,
      sourceInstanceId: null,
      raisedFromRiskItemId: null,
      containment: null,
      correction: null,
      disposition: null,
      dispositionAuthorisedById: null,
      rootCauseMethod: null,
      rootCause: null,
      similarOccurrences: null,
      relatedRiskItemIds: [],
      updatedRiskItemIds: [],
      riskReview: null,
      systemChange: null,
      changedDocumentIds: [],
      noActionReason: null,
      effectivenessDueOn: null,
      effectivenessNote: null,
      effective: null,
      closedOn: null,
      cancelReason: null,
      incident: null,
      ...fields,
    });
    return k(`nc:${key}`);
  };
  const instanceOf = (code: string, unit: string, periodStart: string) =>
    b(`instance:${code}:${unit}:${periodStart}`);

  // 1. CLOSED, raised from the stage 2 finding.
  const ncCalibration = addNc('calibration-records', {
    source: 'EXTERNAL_AUDIT',
    severity: 'MINOR',
    standards: ['ISO_9001'],
    clauseIds: [Q('7.1.5.1')],
    unitId: PUNE,
    description: 'Calibration records for two packing-line scales could not be found.',
    reportedById: who('kabir'),
    reportedOn: '2024-07-03',
    containment:
      'Both scales checked against test weights; results since the last record were checked and held.',
    correction: 'Both scales calibrated by an accredited laboratory.',
    rootCauseMethod: 'FIVE_WHYS',
    rootCause: 'Calibration was tracked in a personal spreadsheet that was not handed over.',
    similarOccurrences: 'Checked every instrument at both units; no other gaps.',
    riskReview: 'None needed: calibration is now a recurring activity.',
    systemChange: 'Calibration moved into the activity register with reminders.',
    ownerId: who('rohan'),
    approverId: who('nisha'),
    dueOn: '2024-07-31',
    effectivenessDueOn: '2024-10-15',
    effectivenessNote: 'Two quarterly calibrations since were on time with records filed.',
    effective: true,
    closedOn: '2024-10-18',
    state: 'CLOSED',
    updated: '2024-10-18',
    version: 6,
  });
  // 2. AWAITING_VERIFICATION: an incident, its statutory notice linked; no personal data outside files.
  const ncIncident = addNc('oven-tray-incident', {
    source: 'INCIDENT',
    severity: 'MINOR',
    standards: ['ISO_45001'],
    clauseIds: [S('10.2')],
    unitId: PUNE,
    description:
      'An oven tray was moved by hand without heat-resistant gloves during a tray change on line 2.',
    reportedById: who('rohan'),
    reportedOn: '2024-08-19',
    containment: 'Line 2 tray changes stopped until gloves were at every oven.',
    correction: 'Gloves put at each oven; the shift briefed the same day.',
    rootCauseMethod: 'FISHBONE',
    rootCause:
      'Gloves were kept in a store away from the ovens, and the tray change was rushed at shift end.',
    similarOccurrences: 'Line 1 has the same layout; gloves were moved there too.',
    relatedRiskItemIds: [riskOven],
    updatedRiskItemIds: [riskOven],
    riskReview: 'The oven hazard was re-rated after the incident and a guard rail added.',
    systemChange: 'Tray changes added to the line 2 work instruction.',
    ownerId: who('rohan'),
    approverId: who('nisha'),
    dueOn: '2024-09-30',
    effectivenessDueOn: '2024-11-12',
    state: 'AWAITING_VERIFICATION',
    incident: {
      occurredAt: '2024-08-19T09:40:00Z',
      location: 'Line 2 oven bay',
      type: 'INJURY',
      outcome: 'LOST_TIME',
      personCategory: 'CONTRACT_WORKER',
      lostDays: 3,
      reportable: true,
      statutoryInstanceId: instanceOf('SLC-EHS-012', 'Pune Plant', '2024-08-19'),
      investigatorIds: [who('rohan'), who('sameer')],
      workerParticipation: true,
    },
    updated: '2024-09-12',
    version: 5,
  });
  // 3. ACTIONS_PLANNED, raised from the Q2 internal audit finding; overdue.
  const ncTray = addNc('tray-change', {
    source: 'INTERNAL_AUDIT',
    severity: 'MINOR',
    standards: ['ISO_45001'],
    clauseIds: [S('8.1.2')],
    unitId: PUNE,
    description: 'Line 2 tray changes rely on gloves alone; no engineering control was considered.',
    reportedById: who('sameer'),
    reportedOn: '2024-09-18',
    containment: 'Two people now do each tray change until a control is chosen.',
    correction: 'Guard rail on the line 2 oven doors brought forward.',
    rootCauseMethod: 'FIVE_WHYS',
    rootCause: 'The hazard review did not ask which level of the hierarchy each control was at.',
    similarOccurrences: 'The same gap may exist for the fryer; it is in the next hazard review.',
    relatedRiskItemIds: [riskOven],
    ownerId: who('rohan'),
    approverId: who('nisha'),
    dueOn: '2024-11-10',
    effectivenessDueOn: '2025-01-31',
    state: 'ACTIONS_PLANNED',
    updated: '2024-10-01',
    version: 3,
  });
  // 4. CANCELLED: raised from a drill instance, then found not to be a nonconformity.
  addNc('drill-timing', {
    source: 'PROCESS',
    sourceInstanceId: k('instance:EMERGENCY-DRILL:Pune Plant:2024-04-01'),
    severity: 'MINOR',
    standards: ['ISO_14001', 'ISO_45001'],
    clauseIds: [E('8.2'), S('8.2')],
    unitId: PUNE,
    description: 'The September evacuation drill took nine minutes against a five-minute target.',
    reportedById: who('rohan'),
    reportedOn: '2024-09-30',
    ownerId: who('rohan'),
    approverId: who('nisha'),
    dueOn: '2024-10-31',
    cancelReason:
      'The time included a planned hold at the assembly point; the evacuation itself took four minutes.',
    state: 'CANCELLED',
    updated: '2024-10-03',
    version: 2,
  });
  // 5. ROOT_CAUSE_FOUND, raised from the stage 1 finding.
  addNc('worker-consultation', {
    source: 'EXTERNAL_AUDIT',
    severity: 'MINOR',
    standards: ['ISO_45001'],
    clauseIds: [S('5.4')],
    unitId: PUNE,
    description: 'Contract workers were not invited to the last two safety committee meetings.',
    reportedById: who('kabir'),
    reportedOn: '2024-11-05',
    containment: 'The contractor supervisor joins the November committee meeting.',
    correction: 'Minutes of the last two meetings shared with the contract workers.',
    rootCauseMethod: 'FIVE_WHYS',
    rootCause:
      'The committee invitation list was built from the payroll, which leaves out contract workers.',
    similarOccurrences:
      'The Bengaluru Office has no contract workers; no other list is built this way.',
    ownerId: who('sameer'),
    approverId: who('divya'),
    dueOn: '2024-12-04',
    state: 'ROOT_CAUSE_FOUND',
    updated: '2024-11-13',
    version: 2,
  });
  // 6. OPEN: a near miss at the Bengaluru Office.
  addNc('wet-floor', {
    source: 'NEAR_MISS',
    severity: 'MINOR',
    standards: ['ISO_45001'],
    clauseIds: [S('10.2')],
    unitId: BENGALURU,
    description: 'Water from the pantry spread into the corridor; nobody slipped.',
    reportedById: who('sameer'),
    reportedOn: '2024-11-08',
    ownerId: who('sameer'),
    approverId: who('divya'),
    dueOn: '2024-12-06',
    state: 'OPEN',
    incident: {
      occurredAt: '2024-11-07T08:15:00Z',
      location: 'Second-floor pantry corridor',
      type: 'NEAR_MISS',
      outcome: 'NONE',
      personCategory: 'EMPLOYEE',
      lostDays: null,
      reportable: false,
      statutoryInstanceId: null,
      investigatorIds: [who('sameer')],
      workerParticipation: false,
    },
    updated: '2024-11-08',
    version: 1,
  });
  // 7. OPEN, MAJOR: a customer complaint, with the product held under an authorised disposition.
  const ncComplaint = addNc('allergen-label', {
    source: 'COMPLAINT',
    severity: 'MAJOR',
    standards: ['ISO_9001'],
    clauseIds: [Q('8.5.2'), Q('8.7.1')],
    unitId: PUNE,
    description:
      'One batch of butter cookies was packed in cartons without the milk allergen warning.',
    reportedById: who('kabir'),
    reportedOn: '2024-11-11',
    containment: 'The batch was recalled from three distributors and held at the plant.',
    disposition: 'RETURN_OR_SUSPENSION',
    dispositionAuthorisedById: who('kabir'),
    ownerId: who('rohan'),
    approverId: who('nisha'),
    dueOn: '2024-12-11',
    state: 'OPEN',
    updated: '2024-11-11',
    version: 1,
  });
  addFile(
    'nc:oven-tray-incident',
    'nonconformity',
    ncIncident,
    'incident-investigation-2024-08-19.pdf',
    'rohan',
    '2024-08-23',
  );
  addFile(
    'nc:allergen-label',
    'nonconformity',
    ncComplaint,
    'customer-complaint.pdf',
    'kabir',
    '2024-11-11',
  );
  addFile(
    'nc:allergen-label:duplicate',
    'nonconformity',
    ncComplaint,
    'customer-complaint-copy.png',
    'kabir',
    '2024-11-11',
    'CLEAN',
    {
      on: '2024-11-12',
      reason: 'A copy of the complaint already attached.',
    },
  );

  // ---------- actions on every subject ----------

  const actions: Rows<'actions'> = [];
  type ActionSpec = {
    subject: Row<'actions'>['subject'];
    text: string;
    owner: string;
    created: string;
    dueOn: string;
    state: Row<'actions'>['state'];
    doneOn?: string;
    cancelReason?: string;
    resources?: string;
    effectivenessNote?: string;
    controlHierarchy?: Row<'actions'>['controlHierarchy'];
    outputKey?: Row<'actions'>['outputKey'];
  };
  const addAction = (key: string, a: ActionSpec) => {
    const closed = a.doneOn ?? (a.state === 'CANCELLED' ? addDays(a.created, 10) : a.created);
    actions.push({
      ...record(`action:${key}`, a.created, closed, a.state === 'OPEN' ? 1 : 2),
      subject: a.subject,
      text: a.text,
      resources: a.resources ?? null,
      ownerId: who(a.owner),
      dueOn: a.dueOn,
      doneOn: a.doneOn ?? null,
      state: a.state,
      effectivenessNote: a.effectivenessNote ?? null,
      cancelReason: a.cancelReason ?? null,
      controlHierarchy: a.controlHierarchy ?? null,
      outputKey: a.outputKey ?? null,
    });
    return k(`action:${key}`);
  };
  const nc = (id: string) => ({ type: 'NONCONFORMITY' as const, id });
  const risk = (id: string) => ({ type: 'RISK_ITEM' as const, id });
  const objective = (key: string) => ({ type: 'OBJECTIVE' as const, id: k(`objective:${key}`) });
  const finding = (id: string) => ({ type: 'AUDIT_FINDING' as const, id });
  const reviewId = k('review:2024');
  const review = { type: 'MANAGEMENT_REVIEW' as const, id: reviewId };

  addAction('calibrate-scales', {
    subject: nc(ncCalibration),
    text: 'Calibrate both scales and file the certificates.',
    owner: 'rohan',
    created: '2024-07-10',
    dueOn: '2024-07-26',
    state: 'DONE',
    doneOn: '2024-07-25',
    effectivenessNote: 'Certificates on file.',
  });
  addAction('glove-stations', {
    subject: nc(ncIncident),
    text: 'Put a glove station at every oven and check it each shift.',
    owner: 'rohan',
    created: '2024-08-26',
    dueOn: '2024-09-10',
    state: 'DONE',
    doneOn: '2024-09-10',
  });
  addAction('handled-trays', {
    subject: nc(ncIncident),
    text: 'Replace line 2 trays with trays that have insulated handles.',
    owner: 'rohan',
    created: '2024-08-26',
    dueOn: '2024-10-31',
    state: 'CANCELLED',
    cancelReason:
      'No supplier makes handled trays for these ovens; the guard rail covers the hazard.',
  });
  addAction('retrain-tray-change', {
    subject: nc(ncTray),
    text: 'Retrain line 2 on the tray-change steps, with a sign-off per operator.',
    owner: 'rohan',
    created: '2024-10-01',
    dueOn: '2024-11-30',
    state: 'OPEN',
  });
  addAction('second-supplier', {
    subject: risk(riskFlour),
    text: 'Qualify a second flour supplier.',
    owner: 'sameer',
    created: '2024-05-14',
    dueOn: '2025-01-31',
    state: 'OPEN',
    resources: 'Trial batches on line 1; quality lab time.',
  });
  const guardRail = addAction('guard-rail', {
    subject: risk(riskOven),
    text: 'Fit guard rails on the line 2 oven doors.',
    owner: 'rohan',
    created: '2024-05-21',
    dueOn: '2024-09-15',
    state: 'DONE',
    doneOn: '2024-09-12',
    controlHierarchy: 'ENGINEERING',
  });
  addAction('two-person-change', {
    subject: risk(riskOven),
    text: 'Make every line 2 tray change a two-person task.',
    owner: 'rohan',
    created: '2024-09-20',
    dueOn: '2024-12-15',
    state: 'OPEN',
    controlHierarchy: 'ADMINISTRATIVE',
  });
  addAction('compostable-film', {
    subject: risk(riskPackaging),
    text: 'Trial a compostable film for the snack packs.',
    owner: 'rohan',
    created: '2024-06-03',
    dueOn: '2024-09-30',
    state: 'CANCELLED',
    cancelReason: 'The trial film failed the seal tests.',
  });
  addAction('rooftop-solar', {
    subject: objective('energy'),
    text: 'Install 150 kW of rooftop solar at the Pune Plant.',
    owner: 'rohan',
    created: '2024-04-15',
    dueOn: '2025-02-28',
    state: 'OPEN',
    resources: 'Capital approved; installer chosen.',
  });
  addAction('seal-checks', {
    subject: objective('complaints'),
    text: 'Retrain the packing line on carton seal checks.',
    owner: 'sameer',
    created: '2024-04-15',
    dueOn: '2024-08-31',
    state: 'DONE',
    doneOn: '2024-08-30',
  });
  addAction('carton-supplier', {
    subject: objective('complaints'),
    text: 'Move to a new carton supplier.',
    owner: 'sameer',
    created: '2024-04-15',
    dueOn: '2024-12-31',
    state: 'CANCELLED',
    cancelReason: 'The current supplier fixed the seal width at no cost.',
  });
  addAction('oven-training', {
    subject: objective('oven-training'),
    text: 'Train every line 2 operator in safe oven handling.',
    owner: 'rohan',
    created: '2024-04-15',
    dueOn: '2024-09-30',
    state: 'DONE',
    doneOn: '2024-09-27',
  });
  addAction('re-evaluation-reminder', {
    subject: finding(lateSignatures),
    text: 'Add a reminder a week before each supplier re-evaluation is due.',
    owner: 'sameer',
    created: '2024-06-14',
    dueOn: '2024-07-15',
    state: 'DONE',
    doneOn: '2024-07-15',
  });
  addAction('water-meters', {
    subject: finding(waterFinding),
    text: 'Fit a water meter on each washing line.',
    owner: 'rohan',
    created: '2024-09-20',
    dueOn: '2025-01-31',
    state: 'OPEN',
  });
  addAction('complaint-trends', {
    subject: finding(trendFinding),
    text: 'Trend complaints by product line each month.',
    owner: 'sameer',
    created: '2024-07-04',
    dueOn: '2024-09-30',
    state: 'CANCELLED',
    cancelReason: 'Covered by the quarterly data analysis activity.',
  });
  addAction('supplier-audit-budget', {
    subject: review,
    text: 'Budget for an audit of the second flour supplier.',
    owner: 'kabir',
    created: '2024-10-28',
    dueOn: '2024-12-31',
    state: 'OPEN',
    outputKey: 'RESOURCE_NEEDS',
  });
  addAction('climate-plan', {
    subject: review,
    text: 'Add the climate risk to the three-year business plan.',
    owner: 'kabir',
    created: '2024-10-28',
    dueOn: '2024-11-30',
    state: 'DONE',
    doneOn: '2024-11-06',
    outputKey: 'STRATEGIC_DIRECTION',
  });
  addAction('energy-consultant', {
    subject: review,
    text: 'Hire an energy consultant for the Pune Plant.',
    owner: 'sameer',
    created: '2024-10-28',
    dueOn: '2024-12-31',
    state: 'CANCELLED',
    cancelReason: "The solar installer's energy survey covers it.",
    outputKey: 'RESOURCE_NEEDS',
  });

  const riskControls: Rows<'riskControls'> = [
    {
      ...record('control:flour-stock', '2024-05-14'),
      riskItemId: riskFlour,
      text: 'Two weeks of flour held as safety stock.',
      hierarchy: null,
      sourceActionId: null,
    },
    {
      ...record('control:grease-trap', '2024-05-21'),
      riskItemId: riskEffluent,
      text: 'Grease trap and settling tank before the drain.',
      hierarchy: null,
      sourceActionId: null,
    },
    {
      ...record('control:gloves', '2024-05-21'),
      riskItemId: riskOven,
      text: 'Heat-resistant gloves at each oven.',
      hierarchy: 'PPE',
      sourceActionId: null,
    },
    {
      // Put in place by completing the treatment action.
      ...record('control:guard-rail', '2024-09-12'),
      riskItemId: riskOven,
      text: 'Guard rails on the line 2 oven doors.',
      hierarchy: 'ENGINEERING',
      sourceActionId: guardRail,
    },
    {
      ...record('control:seating', '2024-06-10'),
      riskItemId: riskScreens,
      text: 'Adjustable chairs and monitor arms at every desk.',
      hierarchy: 'ENGINEERING',
      sourceActionId: null,
    },
  ];

  // ---------- management review ----------

  const managementReviews: Rows<'managementReviews'> = [
    {
      ...inSystem('review:2024', '2024-09-23', '2024-10-30', 4),
      standards: ['ISO_9001', 'ISO_14001', 'ISO_45001'],
      plannedOn: '2024-10-28',
      heldOn: '2024-10-28',
      chairId: who('kabir'),
      attendeeIds: [who('divya'), who('sameer'), who('rohan'), who('arjun')],
      minutes:
        'The first integrated review. Quality is certified; environment and health and safety are ready for stage 2 ' +
        'once the stage 1 findings are closed.',
      state: 'HELD',
      cancelReason: null,
    },
  ];
  /** One row per key, from the key's first definition among the review's standards (in standard order). */
  const firstDef = <D extends { id?: string; standardId: string; key: string }>(
    defs: readonly D[],
    key: string,
  ) =>
    CODES.map((c) => defs.find((d) => d.standardId === standard(c).id && d.key === key)).find(
      (d) => d !== undefined,
    );
  const INPUT_NOTES: Record<z.infer<typeof ReviewInputKey>, string> = {
    PREVIOUS_ACTIONS: 'First review in the app: no earlier review actions.',
    CONTEXT_CHANGES:
      'Climate added as an external issue; the line 2 ovens are now an internal issue.',
    INTERESTED_PARTIES:
      'Retailers now ask for recyclable packaging; contract workers want a voice in the committee.',
    SIGNIFICANT_ASPECTS:
      'Effluent is significant by decision; packaging waste is not significant yet.',
    RISKS_AND_OPPORTUNITIES:
      'Flour supply and oven burns are the significant items; solar is the main opportunity.',
    RISK_ACTIONS: 'Guard rails fitted; a second flour supplier is being qualified.',
    CUSTOMER_SATISFACTION: 'Survey score steady; complaints rose in the second quarter.',
    OBJECTIVES: 'Energy on track, complaints off track, oven training achieved.',
    PROCESS_PERFORMANCE: 'Line 1 efficiency up; line 2 limited by the ovens.',
    NONCONFORMITIES: 'One external audit NC closed; the tray-change NC has actions under way.',
    INCIDENTS: 'One lost-time incident in August; investigation done with worker participation.',
    MONITORING_RESULTS: 'Effluent within limits every month; electricity per tonne falling.',
    COMPLIANCE_EVALUATION: 'Half-yearly evaluation done in September; no open legal gaps.',
    AUDIT_RESULTS: 'Q1 and Q2 internal audits reported; stage 2 recommended the certificate.',
    EXTERNAL_PROVIDERS: 'Flour and packaging suppliers rated; one carton supplier on watch.',
    WORKER_CONSULTATION: 'Committee meets quarterly; contract workers to be invited.',
    RESOURCES: 'Solar capital approved; a second quality technician needed in 2025.',
    COMMUNICATIONS: 'Policy revision B shared at both units.',
    IMPROVEMENT_OPPORTUNITIES: 'Water metering by line; complaint trending by product.',
  };
  const reviewInputs: Rows<'reviewInputs'> = ReviewInputKey.options.map((key) => ({
    ...record(`review:2024:input:${key}`, '2024-09-23', '2024-10-25', 2),
    managementReviewId: reviewId,
    inputDefId: firstDef(catalogue.reviewInputDefs, key)!.id!,
    notes: INPUT_NOTES[key],
  }));
  const OUTPUT_DECISIONS: Record<z.infer<typeof ReviewOutputKey>, string | null> = {
    SUITABILITY: 'The system is suitable and effective for the current scope.',
    IMPROVEMENT: 'Meter water by line; trend complaints by product.',
    SYSTEM_CHANGES:
      'Add the Bengaluru Office to the manual; invite contract workers to the committee.',
    RESOURCE_NEEDS: 'Budget for a supplier audit; a second quality technician next year.',
    OBJECTIVES_NOT_MET: 'Complaints objective kept; seal checks to be audited.',
    INTEGRATION: 'Keep one integrated audit programme and one review.',
    STRATEGIC_DIRECTION: 'Climate risk goes into the business plan.',
    // Still to be decided before the review closes.
    WORKER_COMMUNICATION: null,
  };
  const reviewOutputs: Rows<'reviewOutputs'> = ReviewOutputKey.options.map((key) => ({
    ...record(
      `review:2024:output:${key}`,
      '2024-09-23',
      OUTPUT_DECISIONS[key] === null ? '2024-09-23' : '2024-10-30',
      OUTPUT_DECISIONS[key] === null ? 1 : 2,
    ),
    managementReviewId: reviewId,
    outputDefId: firstDef(catalogue.reviewOutputDefs, key)!.id!,
    decision: OUTPUT_DECISIONS[key],
  }));

  // ---------- STANDARD activities on Northwind's register ----------

  /**
   * Activities assigned to Northwind's units, FY 2024-25. Pune is worked by Rohan and approved by Nisha; the Bengaluru
   * Office by Sameer and Divya, whose instance is the one waiting and the one overdue, so the Pune owner's and
   * approver's statutory queues (the web e2e journeys) are unchanged.
   */
  const ACTIVITIES: {
    key: string;
    unit: 'Pune Plant' | 'Bengaluru Office';
    department: string;
    activeFrom: string;
    evidence: string;
  }[] = [
    {
      key: 'WORKPLACE-INSPECTION',
      unit: 'Pune Plant',
      department: 'safety',
      activeFrom: '2024-04-01',
      evidence: 'inspection-record',
    },
    {
      key: 'EMERGENCY-DRILL',
      unit: 'Pune Plant',
      department: 'safety',
      activeFrom: '2024-04-01',
      evidence: 'drill-report',
    },
    {
      key: 'CALIBRATION',
      unit: 'Pune Plant',
      department: 'safety',
      activeFrom: '2024-04-01',
      evidence: 'calibration-status',
    },
    {
      key: 'ENV-MONITORING',
      unit: 'Pune Plant',
      department: 'safety',
      activeFrom: '2024-10-01',
      evidence: 'monitoring-data',
    },
    {
      key: 'AWARENESS',
      unit: 'Bengaluru Office',
      department: 'hr',
      activeFrom: '2024-04-01',
      evidence: 'attendance-record',
    },
    {
      key: 'WORKER-CONSULTATION',
      unit: 'Bengaluru Office',
      department: 'hr',
      activeFrom: '2024-04-01',
      evidence: 'committee-minutes',
    },
    {
      key: 'DATA-ANALYSIS',
      unit: 'Bengaluru Office',
      department: 'finance',
      activeFrom: '2024-04-01',
      evidence: 'analysis-record',
    },
  ];
  /** Instances whose state is not the default (APPROVED when due before this date, OPEN otherwise). */
  const SETTLED_BEFORE = '2024-11-01';
  const SPECIAL: Record<string, 'SUBMITTED' | 'OPEN'> = {
    // Done late and still waiting for Divya.
    'AWARENESS:2024-04-01': 'SUBMITTED',
    // Overdue: the Q2 consultation was not held.
    'WORKER-CONSULTATION:2024-07-01': 'OPEN',
  };
  const assignments: Rows<'assignments'> = [];
  const instances: Rows<'instances'> = [];
  const evidence: Rows<'evidence'> = [];
  for (const activity of ACTIVITIES) {
    const pune = activity.unit === 'Pune Plant';
    const unitId = pune ? PUNE : BENGALURU;
    const [owner, approver] = pune ? ['rohan', 'nisha'] : ['sameer', 'divya'];
    const obligationId = isoCatalogueId(FIRM_B_ID, `obligation:${activity.key}`);
    const rule = catalogue.obligations.find((o) => o.id === obligationId)!.recurrenceRule;
    const assignmentId = k(`assignment:${activity.key}:${activity.unit}`);
    assignments.push({
      ...record(`assignment:${activity.key}:${activity.unit}`, '2024-04-12'),
      unitId,
      obligationId,
      departmentId: b(`department:${activity.department}`),
      defaultOwnerId: who(owner),
      defaultApproverId: who(approver),
      applicability: 'APPLICABLE',
      naReason: null,
      activeFrom: activity.activeFrom,
      activeTo: null,
    });
    for (const period of periodsIn(rule, 2024, 4)) {
      if (period.periodEnd < activity.activeFrom) continue;
      const key = `instance:${activity.key}:${activity.unit}:${period.periodStart}`;
      const state =
        SPECIAL[`${activity.key}:${period.periodStart}`] ??
        (period.dueDate < SETTLED_BEFORE ? 'APPROVED' : 'OPEN');
      const completedOn =
        state === 'APPROVED'
          ? addDays(period.dueDate, -2)
          : state === 'SUBMITTED'
            ? addDays(period.dueDate, 3)
            : null;
      const submittedAt = completedOn === null ? null : at(completedOn, '09:00:00');
      const approvedAt = state === 'APPROVED' ? at(addDays(completedOn!, 1), '10:00:00') : null;
      const instanceId = k(key);
      instances.push({
        ...record(
          key,
          '2024-04-12',
          '2024-04-12',
          state === 'OPEN' ? 1 : state === 'SUBMITTED' ? 2 : 3,
        ),
        updatedAt: approvedAt ?? submittedAt ?? at('2024-04-12'),
        unitId,
        assignmentId,
        ...period,
        workflowState: state,
        pendingKind: state === 'SUBMITTED' ? 'COMPLETION' : null,
        completedOn,
        naReason: null,
        ownerId: who(owner),
        approverId: who(approver),
        submittedAt,
        approvedAt,
        dueDateOverridden: false,
      });
      // Every done instance carries its record: the evidence the activity asks for.
      if (completedOn !== null) {
        const evidenceId = k(`evidence:${key}`);
        const fileName = `${activity.evidence}-${period.periodStart.slice(0, 7)}.pdf`;
        const uploadedAt = at(completedOn, '08:30:00');
        evidence.push({
          id: evidenceId,
          firmId: FIRM_B_ID,
          createdAt: uploadedAt,
          updatedAt: uploadedAt,
          archivedAt: null,
          instanceId,
          clientId: NORTHWIND,
          fileName,
          mimeType: 'application/pdf',
          sizeBytes: 64_000 + evidence.length * 1_000,
          sha256: sha256(`${evidenceId}:${fileName}`),
          scanStatus: 'CLEAN',
          uploadedById: who(owner),
          storageKey: `${FIRM_B_ID}/${NORTHWIND}/${instanceId}/${evidenceId}`,
        });
      }
    }
  }

  // ---------- the audit trail: a sample, each event as the mock's route writes it ----------

  // ISO records' events joined the client audit trail in contracts 1.8.3 (ISO-1b). The sample names every ISO entity
  // type: the system's set-up with its checklist rows, one record of each other kind created, and one form's first
  // revision from draft to approval. It leaves out every step the mock's rules or the held review's figures read (a
  // context or risk UPDATE, an NC's later steps, an audit's REPORT, an external audit's RECORD_HELD, an action's
  // COMPLETE or CANCEL), so they read the records as they did before (docs/contracts/fixtures.md §8).
  type Event = Row<'auditEvents'>;
  const auditEvents: Rows<'auditEvents'> = [];
  let request = 0;
  /** Starts a request: the events written until the next one share its id. */
  const newRequest = () => `fixture-iso-${(request += 1)}`;
  const trail = (
    requestId: string,
    when: string,
    actorId: string,
    action: Event['action'],
    entity: { type: Event['entityType']; id: string },
    after: Record<string, unknown>,
    before: Record<string, unknown> | null = null,
  ) => {
    auditEvents.push({
      id: k(`audit:${auditEvents.length + 1}`),
      firmId: FIRM_B_ID,
      clientId: NORTHWIND,
      at: when,
      requestId,
      actorId,
      actorKind: 'PERSON',
      action,
      entityType: entity.type,
      entityId: entity.id,
      before,
      after,
      reason: null,
    });
  };
  const BASE = new Set(['id', 'firmId', 'clientId', 'createdAt', 'updatedAt', 'archivedAt']);
  /** A record's own fields, as a CREATE that writes them all records them. */
  const own = (row: object) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => !BASE.has(key) && key !== 'version'));
  /** A record's CREATE, in a request of its own, at its `createdAt`. */
  const created = (
    row: { id?: string | undefined; createdAt?: string | undefined },
    type: Event['entityType'],
    actorId: string,
    after: Record<string, unknown>,
  ) => trail(newRequest(), row.createdAt!, actorId, 'CREATE', { type, id: row.id! }, after);
  const find = <T extends { id?: string | undefined }>(rows: T[], key: string) => {
    const found = rows.find((r) => r.id === k(key));
    if (found === undefined) throw new Error(`No ISO row ${key}`);
    return found;
  };
  const KABIR = who('kabir');

  // The system, set up as PLANNING with all three standards, writes one checklist row per assessable clause.
  const setUp = newRequest();
  trail(
    setUp,
    system.createdAt!,
    KABIR,
    'CREATE',
    { type: 'management_system', id: systemId },
    {
      name: system.name,
      standardIds: system.standardIds,
      scopeStatement: system.scopeStatement,
      unitIds: system.unitIds,
      status: 'PLANNING',
      reviewIntervalMonths: system.reviewIntervalMonths,
    },
  );
  for (const row of clauseAssessments) {
    trail(
      setUp,
      system.createdAt!,
      KABIR,
      'CREATE',
      { type: 'clause_assessment', id: row.id! },
      { managementSystemId: systemId, clauseId: row.clauseId, status: 'NOT_STARTED' },
    );
  }
  for (const key of ['context:packaging', 'context:regulator']) {
    const item = find(contextItems, key);
    created(item, 'context_item', KABIR, {
      managementSystemId: systemId,
      kind: item.kind,
      text: item.text,
      needs: item.needs,
      climateRelated: item.climateRelated,
      reviewedOn: item.reviewedOn,
    });
  }
  // The energy objective links its risk item only once that item is recorded (2024-05-14).
  const energy = find(objectives, 'objective:energy');
  created(energy, 'objective', KABIR, { ...own(energy), riskItemIds: [] });
  const solar = find(actions, 'action:rooftop-solar');
  created(solar, 'iso_action', KABIR, {
    subject: solar.subject,
    ownerId: solar.ownerId,
    dueOn: solar.dueOn,
    state: 'OPEN',
    controlHierarchy: solar.controlHierarchy,
    outputKey: solar.outputKey,
  });
  const programme = find(auditProgrammes, 'programme:2024-25');
  created(programme, 'audit_programme', KABIR, {
    managementSystemId: systemId,
    fy: programme.fy,
    notes: programme.notes,
  });
  const q1 = find(internalAudits, 'audit:q1-quality');
  created(q1, 'internal_audit', KABIR, {
    programmeId: q1.programmeId,
    title: q1.title,
    plannedStart: q1.plannedStart,
    plannedEnd: q1.plannedEnd,
    clauseIds: q1.clauseIds,
    unitIds: q1.unitIds,
    leadAuditorId: q1.leadAuditorId,
    auditorIds: q1.auditorIds,
    auditeeIds: q1.auditeeIds,
    reportedToIds: q1.reportedToIds,
    independenceNote: q1.independenceNote,
    state: 'PLANNED',
  });

  // The oven temperature log: created, its first revision drafted by its owner, submitted and approved.
  const ovenLog = find(documents, 'document:NFG-FRM-03');
  const ovenLogRevision = revisions.find((r) => r.documentId === ovenLog.id)!;
  created(ovenLog, 'controlled_document', KABIR, {
    managementSystemId: systemId,
    code: ovenLog.code,
    title: ovenLog.title,
    type: ovenLog.type,
    clauseIds: ovenLog.clauseIds,
    ownerId: ovenLog.ownerId,
    approverId: ovenLog.approverId,
    reviewDueOn: ovenLog.reviewDueOn,
  });
  created(ovenLogRevision, 'document_revision', ovenLogRevision.preparedById, {
    action: 'DRAFT_REVISION',
    documentId: ovenLog.id,
    revision: ovenLogRevision.revision,
    state: 'DRAFT',
  });
  const flourStock = find(riskControls, 'control:flour-stock');
  created(flourStock, 'risk_control', KABIR, own(flourStock));
  trail(
    newRequest(),
    at('2024-05-16'),
    ovenLogRevision.preparedById,
    'TRANSITION',
    { type: 'document_revision', id: ovenLogRevision.id! },
    { action: 'SUBMIT', state: 'IN_REVIEW', sendBackReason: null },
    { state: 'DRAFT', sendBackReason: null },
  );
  const approval = newRequest();
  trail(
    approval,
    ovenLogRevision.approvedAt!,
    ovenLogRevision.approvedById!,
    'TRANSITION',
    { type: 'document_revision', id: ovenLogRevision.id! },
    {
      action: 'APPROVE',
      state: 'APPROVED',
      approvedById: ovenLogRevision.approvedById,
      approvedAt: ovenLogRevision.approvedAt,
    },
    { state: 'IN_REVIEW', approvedById: null, approvedAt: null },
  );
  trail(
    approval,
    ovenLogRevision.approvedAt!,
    ovenLogRevision.approvedById!,
    'UPDATE',
    { type: 'controlled_document', id: ovenLog.id! },
    { currentRevisionId: ovenLogRevision.id },
    { currentRevisionId: null },
  );
  // Unchanged since it was recorded, so the route's CREATE (never reviewed yet, no override) is the record itself.
  const packagingWaste = find(riskItems, 'risk:packaging-waste');
  created(packagingWaste, 'risk_item', KABIR, own(packagingWaste));

  const lateSignaturesFinding = findings.find((f) => f.id === lateSignatures)!;
  created(lateSignaturesFinding, 'audit_finding', q1.leadAuditorId, {
    internalAuditId: q1.id,
    type: lateSignaturesFinding.type,
    clauseIds: lateSignaturesFinding.clauseIds,
    unitId: lateSignaturesFinding.unitId,
    nonconformityId: lateSignaturesFinding.nonconformityId,
  });
  const firstEnergyReading = readings.find((r) => r.objectiveId === energy.id)!;
  created(firstEnergyReading, 'objective_reading', firstEnergyReading.recordedById, {
    ...own(firstEnergyReading),
  });
  const qualityCertificate = find(certifications, 'certification:9001');
  created(qualityCertificate, 'certification', KABIR, own(qualityCertificate));
  const surveillance = find(externalAudits, 'external:surveillance-1');
  created(surveillance, 'external_audit', KABIR, own(surveillance));

  const firstReview = managementReviews[0]!;
  const defKey = <D extends { id?: string | undefined; key: string }>(defs: D[], id: string) =>
    defs.find((d) => d.id === id)!.key;
  created(firstReview, 'management_review', KABIR, {
    managementSystemId: systemId,
    standards: firstReview.standards,
    plannedOn: firstReview.plannedOn,
    chairId: firstReview.chairId,
    attendeeIds: firstReview.attendeeIds,
    state: 'PLANNED',
    inputKeys: ReviewInputKey.options.filter((key) =>
      reviewInputs.some((r) => defKey(catalogue.reviewInputDefs, r.inputDefId) === key),
    ),
    outputKeys: ReviewOutputKey.options.filter((key) =>
      reviewOutputs.some((r) => defKey(catalogue.reviewOutputDefs, r.outputDefId) === key),
    ),
  });

  // A near miss reported by hand: its RAISE names the incident's type, outcome and reportability, never the person.
  const nearMiss = nonconformities.find((n) => n.number === 6)!;
  created(nearMiss, 'nonconformity', nearMiss.reportedById, {
    action: 'RAISE',
    number: nearMiss.number,
    source: nearMiss.source,
    severity: nearMiss.severity,
    standards: nearMiss.standards,
    clauseIds: nearMiss.clauseIds,
    unitId: nearMiss.unitId,
    sourceInstanceId: nearMiss.sourceInstanceId,
    raisedFromRiskItemId: nearMiss.raisedFromRiskItemId,
    ownerId: nearMiss.ownerId,
    approverId: nearMiss.approverId,
    dueOn: nearMiss.dueOn,
    state: 'OPEN',
    incident: {
      type: nearMiss.incident!.type,
      outcome: nearMiss.incident!.outcome,
      reportable: nearMiss.incident!.reportable,
    },
  });
  const q3 = find(internalAudits, 'audit:q3-office');
  const recordsQuestion = auditChecklistItems.find(
    (i) => i.internalAuditId === q3.id && i.version === 1,
  )!;
  created(recordsQuestion, 'audit_checklist_item', q3.leadAuditorId, {
    internalAuditId: q3.id,
    clauseId: recordsQuestion.clauseId,
    unitId: recordsQuestion.unitId,
    question: recordsQuestion.question,
  });

  return {
    source: 'synthetic: Northwind Foods Group ISO 9001, 14001 and 45001 (fictional)',
    firmId: FIRM_B_ID,
    catalogueCopiedAt: CATALOGUE_COPIED_AT,
    assignments,
    instances,
    evidence,
    managementSystems: [system],
    contextItems,
    clauseAssessments,
    documents,
    revisions,
    riskItems,
    riskControls,
    objectives,
    readings,
    auditProgrammes,
    internalAudits,
    auditChecklistItems,
    certifications,
    externalAudits,
    findings,
    nonconformities,
    actions,
    managementReviews,
    reviewInputs,
    reviewOutputs,
    files,
    auditEvents,
  };
}
