import type {
  CanopyField,
  Criticality,
  ImportIssue,
  ImportRowOutcome,
  InferredRule,
  IssueDecision,
  Jurisdiction,
  LocalDate,
  ObligationDomain,
  RecurrenceRule,
  RuleStatus,
  TemplateRef,
  TimelineType,
} from '@canopy/contracts';
import type { RawCell } from './read.js';

/** Library value already stored for the firm or client, with its accepted aliases. */
export interface KnownName {
  name: string;
  aliases: string[];
}

export interface KnownPerson {
  nameNormalized: string;
  displayName: string;
}

/**
 * What the database already holds for this client, by natural key. The commit step (with M3) loads it;
 * `stateAfterCommit` derives the state a commit leaves, which makes re-import checks pure.
 * Fingerprints are opaque strings from `fingerprint*`; a different fingerprint means "update".
 */
export interface ExistingState {
  acts: KnownName[];
  categories: KnownName[];
  departments: KnownName[];
  people: KnownPerson[];
  companies: string[];
  units: string[];
  locations: string[];
  obligations: Record<string, string>;
  assignments: Record<string, string>;
  instances: Record<string, string>;
}

export const EMPTY_STATE: ExistingState = {
  acts: [],
  categories: [],
  departments: [],
  people: [],
  companies: [],
  units: [],
  locations: [],
  obligations: {},
  assignments: {},
  instances: {},
};

export interface Decision {
  decision: IssueDecision;
  editedValue: string | null;
}

/** Decisions by issue groupKey. Missing groups are PENDING. */
export type Decisions = Record<string, Decision>;

/** An ImportIssue before the API gives it an id and batch. */
export type DraftIssue = Omit<ImportIssue, 'id' | 'batchId'>;

export interface PlanNamed {
  /** The name as it will be stored. Also its key within the plan. */
  name: string;
  /** Other spellings merged into it on this import. */
  aliases: string[];
}

export interface PlanAct extends PlanNamed {
  jurisdiction: Jurisdiction;
  stateCode: string | null;
}

export interface PlanPerson {
  nameNormalized: string;
  displayName: string;
}

export interface PlanCompany {
  key: string;
  name: string;
}

export interface PlanLocation {
  key: string;
  country: string;
  countryCode: string;
  state: string | null;
  stateCode: string | null;
  city: string | null;
}

export interface PlanUnit {
  key: string;
  companyKey: string;
  name: string;
  locationKey: string;
}

export interface PlanObligation {
  key: string;
  externalRef: string | null;
  domain: ObligationDomain;
  jurisdiction: Jurisdiction;
  stateCode: string | null;
  act: string;
  category: string;
  title: string;
  description: string;
  applicabilityText: string | null;
  criticality: Criticality;
  timelineType: TimelineType;
  /** Null when the obligation already exists: its rule then belongs to the library and is not re-inferred. */
  inferred: InferredRule | null;
  recurrenceRule: RecurrenceRule | null;
  ruleStatus: RuleStatus | null;
  forms: TemplateRef[];
  logSheets: TemplateRef[];
}

export interface PlanAssignment {
  key: string;
  unitKey: string;
  obligationKey: string;
  department: string;
  /** Person nameNormalized. */
  defaultOwner: string;
  defaultApprover: string;
  /** Earliest imported due date. */
  firstDueDate: LocalDate;
}

export interface PlanInstance {
  key: string;
  assignmentKey: string;
  /** Source rows; the first is the one kept. */
  rowNumbers: number[];
  dueDate: LocalDate;
  workflowState: 'OPEN' | 'APPROVED' | 'NOT_APPLICABLE';
  completedOn: LocalDate | null;
  naReason: string | null;
  owner: string;
  approver: string;
  /** IMPORT comments, oldest first. */
  comments: string[];
}

/** The span a register covers; `inferRule` scores candidate rules over it. */
export interface Coverage {
  from: LocalDate;
  to: LocalDate;
}

export interface ImportPlan {
  /** What `inferRule` was given: the input's coverage, else whole FYs around the due dates; null without rows. */
  coverage: Coverage | null;
  acts: PlanAct[];
  categories: PlanNamed[];
  departments: PlanNamed[];
  people: PlanPerson[];
  companies: PlanCompany[];
  locations: PlanLocation[];
  units: PlanUnit[];
  obligations: PlanObligation[];
  assignments: PlanAssignment[];
  instances: PlanInstance[];
}

export interface AnalysedRow {
  rowNumber: number;
  /** As read. Personal data: never log. */
  raw: Record<string, RawCell>;
  /** Cleaned value per mapped field, as text. */
  mapped: Partial<Record<CanopyField, string | null>>;
  issueGroupKeys: string[];
  /** PENDING until the dry run; ERROR when a pending ERROR issue blocks it; SKIPPED when a decision drops it. */
  outcome: ImportRowOutcome;
  instanceKey: string | null;
}

export interface ImportAnalysis {
  rows: AnalysedRow[];
  issues: DraftIssue[];
  plan: ImportPlan;
  counts: { rows: number; errors: number; warnings: number; infos: number };
}
