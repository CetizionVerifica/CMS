// @canopy/engine: compliance calculations (MODULES.md M4, packages/engine/CLAUDE.md).
// Pure functions: no database, network, clock or file access. `asOf` is always a parameter.
import type { EngineApi, IsoEngineApi } from '@canopy/contracts';
import { inferRule } from './infer.js';
import { planIsoNotifications } from './iso-notifications.js';
import { reviewInputFigures } from './iso-review.js';
import {
  auditProgrammeCoverage,
  certificationReadiness,
  clauseReadiness,
  climateDeterminationGaps,
  incidentCounts,
  isSignificant,
  objectiveProgress,
  riskRating,
} from './iso-score.js';
import {
  actionStatus,
  certificationCycle,
  isoTransition,
  managementReviewDue,
  nonconformityStatus,
  reviewDue,
} from './iso-status.js';
import { planNotifications } from './notifications.js';
import { generateInstances } from './recurrence.js';
import { computeScore } from './score.js';
import { deriveStatus } from './status.js';
import { ENGINE_VERSION } from './version.js';

export * from './dates.js';
export * from './infer.js';
export * from './iso-notifications.js';
export * from './iso-review.js';
export * from './iso-score.js';
export * from './iso-status.js';
export * from './notifications.js';
export * from './periods.js';
export * from './recurrence.js';
export * from './score.js';
export * from './status.js';
export * from './version.js';

/** The engine as the contract describes it; `satisfies` fails the build if a signature drifts from EngineApi. */
export const engine = {
  generateInstances,
  inferRule,
  deriveStatus,
  computeScore,
  planNotifications,
  ENGINE_VERSION,
} satisfies EngineApi;

/** The ISO engine (docs/iso/model.md §5); `satisfies` fails the build if a signature drifts from IsoEngineApi. */
export const isoEngine = {
  riskRating,
  isSignificant,
  clauseReadiness,
  certificationReadiness,
  objectiveProgress,
  auditProgrammeCoverage,
  incidentCounts,
  climateDeterminationGaps,
  isoTransition,
  nonconformityStatus,
  actionStatus,
  certificationCycle,
  managementReviewDue,
  reviewDue,
  planIsoNotifications,
  reviewInputFigures,
} satisfies IsoEngineApi;
