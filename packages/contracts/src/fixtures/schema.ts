import { z } from 'zod';
import { DerivedStatus, TimelineType, WorkflowState } from '../enums.js';
import { Id, LocalDate, Name, Text } from '../primitives.js';
import { Act, Category, Obligation, RecurrenceRule } from '../schemas/library.js';
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
