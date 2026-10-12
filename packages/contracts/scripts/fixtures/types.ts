// The JSON shapes the generators write: schema inputs, so plain date strings type-check before parsing.
import type { z } from 'zod';
import type * as C from '../../src/index.js';

export type Act = z.input<typeof C.Act>;
export type Assignment = z.input<typeof C.Assignment>;
export type AuditEvent = z.input<typeof C.AuditEvent>;
export type Category = z.input<typeof C.Category>;
export type Comment = z.input<typeof C.Comment>;
export type ComplianceInstance = z.input<typeof C.ComplianceInstance>;
export type Department = z.input<typeof C.Department>;
export type DueDatesFixture = z.input<typeof C.DueDatesFixture>;
export type Evidence = z.input<typeof C.Evidence>;
export type ExpectedFixture = z.input<typeof C.ExpectedFixture>;
export type ExpectedProfile = z.input<typeof C.ExpectedProfile>;
export type ExpectedScore = z.input<typeof C.ExpectedScore>;
export type FixtureSet = z.input<typeof C.FixtureSet>;
export type Membership = z.input<typeof C.Membership>;
export type Obligation = z.input<typeof C.Obligation>;
export type Person = z.input<typeof C.Person>;
export type RecurrenceRule = z.input<typeof C.RecurrenceRule>;
export type TemplateRef = z.input<typeof C.TemplateRef>;
export type {
  Criticality,
  DerivedStatus,
  ObligationDomain,
  ScanStatus,
  TimelineType,
  WorkflowState,
} from '../../src/index.js';
