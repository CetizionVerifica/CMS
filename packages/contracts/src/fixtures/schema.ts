import { z } from 'zod';
import { DerivedStatus, IsoStandardCode, TimelineType, WorkflowState } from '../enums.js';
import { ClauseNumber, Id, Instant, LocalDate, LongText, Name, Text } from '../primitives.js';
import {
  AuditChecklistItem,
  AuditFinding,
  AuditProgramme,
  Certification,
  ClauseAssessment,
  ClauseItem,
  ContextItem,
  ControlledDocument,
  DocumentRevision,
  ExternalAudit,
  InternalAudit,
  IsoAction,
  IsoEdition,
  IsoFile,
  ManagementReview,
  ManagementSystem,
  Nonconformity,
  Objective,
  ObjectiveReading,
  ReviewInput,
  ReviewInputKey,
  ReviewInputSource,
  ReviewOutput,
  ReviewOutputKey,
  RiskControl,
  RiskItem,
} from '../schemas/iso.js';
import { Act, Category, ClauseRef, Obligation, RecurrenceRule } from '../schemas/library.js';
import {
  Client,
  Company,
  Department,
  Firm,
  Location,
  Membership,
  Person,
  Unit,
} from '../schemas/tenancy.js';
import { Assignment, AuditEvent, Comment, ComplianceInstance, Evidence } from '../schemas/work.js';

/** Typed fixtures (docs/contracts/fixtures.md). The JSON lives in packages/contracts/fixtures/. */

/** One firm's data, every entity in its strict schema. Ids are deterministic UUIDv5 (`fixtureId`). */
export const FixtureSet = z.strictObject({
  /** What the set was generated from. */
  source: Text,
  firm: Firm,
  clients: z.array(Client),
  companies: z.array(Company),
  locations: z.array(Location),
  units: z.array(Unit),
  departments: z.array(Department),
  people: z.array(Person),
  memberships: z.array(Membership),
  acts: z.array(Act),
  categories: z.array(Category),
  obligations: z.array(Obligation),
  assignments: z.array(Assignment),
  instances: z.array(ComplianceInstance),
  evidence: z.array(Evidence),
  comments: z.array(Comment),
  auditEvents: z.array(AuditEvent),
});
export type FixtureSet = z.infer<typeof FixtureSet>;

/** `firm-a.due-dates.json`: the input and expected output of M4's golden test (fixtures.md §5). */
export const DueDatesFixture = z.array(
  z.strictObject({
    externalRef: Text,
    timelineType: TimelineType,
    /** Distinct FY 2022-23 due dates from the sample, ascending. */
    dueDates: z.array(LocalDate).min(1),
    /** The rule M0 expects inferRule to return; null where the dates leave it unclear. */
    expectedRule: RecurrenceRule.nullable(),
    /** True when expectedRule regenerates every date; false means confidence < 1 with mismatches. */
    exact: z.boolean(),
  }),
);
export type DueDatesFixture = z.infer<typeof DueDatesFixture>;

const statusCounts = z.record(DerivedStatus, z.int().min(0));

/** Derived status and score for one asOf (fixtures.md §4). */
export const ExpectedScore = z.strictObject({
  asOf: LocalDate,
  /** Derived status of every instance at asOf. */
  counts: statusCounts,
  /** Instances with dueDate <= asOf, excluding NOT_APPLICABLE: the score's denominator rows. */
  due: z.int().min(0),
  weightedNumerator: z.number().min(0),
  weightedDenominator: z.number().min(0),
  score: z.number().min(0).max(100).nullable(),
  onTimeRate: z.number().min(0).max(100).nullable(),
});
export type ExpectedScore = z.infer<typeof ExpectedScore>;

export const ExpectedProfile = z.strictObject({
  counts: z.strictObject({
    obligations: z.int(),
    instances: z.int(),
    workflowStates: z.record(WorkflowState, z.int().min(0)),
    acts: z.int(),
    categories: z.int(),
    departments: z.int(),
    /** People named in the register (owners and approvers). */
    people: z.int(),
    assignments: z.int(),
  }),
  scores: z.array(ExpectedScore),
});
export type ExpectedProfile = z.infer<typeof ExpectedProfile>;

/** `firm-a.expected.json`: every count and score golden tests assert (fixtures.md §3-§5). */
export const ExpectedFixture = z.strictObject({
  profiles: z.strictObject({ raw: ExpectedProfile, recommended: ExpectedProfile }),
  /** Recommended profile, per asOf: the instance ids behind each derived status. */
  instanceIds: z.array(
    z.strictObject({ asOf: LocalDate, ids: z.record(DerivedStatus, z.array(Id)) }),
  ),
  /** Recommended profile breakdowns (by department, Act and criticality) at each asOf. */
  breakdowns: z.array(
    z.strictObject({
      asOf: LocalDate,
      by: z.enum(['department', 'act', 'criticality']),
      rows: z.array(z.strictObject({ key: Text, label: Name, result: ExpectedScore })),
    }),
  ),
  /** Sample findings from fixtures.md §3, as data. */
  findings: z.strictObject({
    duplicatePeriods: z.array(z.strictObject({ externalRef: Text, dueDate: LocalDate })),
    compliedWithoutDate: z.array(z.strictObject({ externalRef: Text, dueDate: LocalDate })),
    unparsedExternalRefs: z.array(Text),
  }),
});
export type ExpectedFixture = z.infer<typeof ExpectedFixture>;

// ---------- ISO add-on (fixtures.md §8) ----------

/**
 * `iso.catalogue.json`: the ISO catalogue an account's copy starts from (docs/iso/catalogue.md), without ids or firm.
 * `isoCatalogueRows(firmId, at)` turns it into one account's rows, with ids that are the same on every load.
 */
export const IsoCatalogueFixture = z.strictObject({
  version: Text.max(20),
  standards: z.array(
    z.strictObject({ code: IsoStandardCode, edition: IsoEdition, title: Name, topic: Name }),
  ),
  clauses: z.array(
    z.strictObject({
      standard: IsoStandardCode,
      number: ClauseNumber,
      title: Text.max(200),
      summary: Text.max(1000),
      parent: ClauseNumber.nullable(),
      hlsKey: ClauseNumber.nullable(),
      assessable: z.boolean(),
      exclusionAllowed: z.boolean(),
    }),
  ),
  reviewInputs: z.array(
    z.strictObject({
      standard: IsoStandardCode,
      key: ReviewInputKey,
      clauseNumber: ClauseNumber,
      item: ClauseItem.nullable(),
      title: Text.max(300),
      source: ReviewInputSource,
    }),
  ),
  reviewOutputs: z.array(
    z.strictObject({
      standard: IsoStandardCode,
      key: ReviewOutputKey,
      clauseNumber: ClauseNumber,
      item: ClauseItem.nullable(),
      title: Text.max(300),
    }),
  ),
  /** The one category of the STANDARD acts. */
  category: Name,
  acts: z.array(
    z.strictObject({
      key: z.enum(['ISO_9001', 'ISO_14001', 'ISO_45001', 'IMS']),
      name: Name,
      shortName: Name,
    }),
  ),
  /** The recurring activities (catalogue.md §3), each shipped once, under its act. */
  activities: z.array(
    z.strictObject({
      key: z.string().regex(/^[A-Z0-9]+(-[A-Z0-9]+)*$/),
      title: Text.max(1000),
      act: z.enum(['ISO_9001', 'ISO_14001', 'ISO_45001', 'IMS']),
      rule: RecurrenceRule,
      evidence: LongText,
      clauseRefs: z.array(ClauseRef).min(1).max(20),
    }),
  ),
});
export type IsoCatalogueFixture = z.infer<typeof IsoCatalogueFixture>;

/** The ISO records of one firm, every one in its strict schema (the mock store's ISO tables). */
export const IsoTablesShape = {
  managementSystems: z.array(ManagementSystem),
  contextItems: z.array(ContextItem),
  clauseAssessments: z.array(ClauseAssessment),
  documents: z.array(ControlledDocument),
  revisions: z.array(DocumentRevision),
  riskItems: z.array(RiskItem),
  riskControls: z.array(RiskControl),
  objectives: z.array(Objective),
  readings: z.array(ObjectiveReading),
  auditProgrammes: z.array(AuditProgramme),
  internalAudits: z.array(InternalAudit),
  auditChecklistItems: z.array(AuditChecklistItem),
  certifications: z.array(Certification),
  externalAudits: z.array(ExternalAudit),
  findings: z.array(AuditFinding),
  nonconformities: z.array(Nonconformity),
  actions: z.array(IsoAction),
  managementReviews: z.array(ManagementReview),
  reviewInputs: z.array(ReviewInput),
  reviewOutputs: z.array(ReviewOutput),
  files: z.array(IsoFile),
};

/**
 * `firm-b.iso.json`: firm B's ISO add-on data (Northwind Foods Group's integrated management system). The catalogue
 * rows, STANDARD acts, their category and obligations are not stored here: they are `isoCatalogueRows(firm B,
 * catalogueCopiedAt)`, as the account's copy would make them. The STANDARD assignments and instances (with their
 * evidence) join firm B's register data; the ISO records fill the mock's ISO tables.
 */
export const IsoFixtureSet = z.strictObject({
  source: Text,
  firmId: Id,
  /** When the account's catalogue copy was recorded (`Account.isoCatalogueCopiedAt`). */
  catalogueCopiedAt: Instant,
  assignments: z.array(Assignment),
  instances: z.array(ComplianceInstance),
  evidence: z.array(Evidence),
  ...IsoTablesShape,
  /**
   * A sample of the ISO records' audit trail, oldest first, each event as the mock's route writes it (contracts 1.8.3,
   * ISO-1b): it joins firm B's `auditEvents`, so the client audit trail lists it.
   */
  auditEvents: z.array(AuditEvent),
});
export type IsoFixtureSet = z.infer<typeof IsoFixtureSet>;
