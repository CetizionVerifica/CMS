// @canopy/engine: compliance calculations (MODULES.md M4, packages/engine/CLAUDE.md).
// Pure functions: no database, network, clock or file access. `asOf` is always a parameter.
import type { EngineApi } from '@canopy/contracts';
import { inferRule } from './infer.js';
import { planNotifications } from './notifications.js';
import { generateInstances } from './recurrence.js';
import { computeScore } from './score.js';
import { deriveStatus } from './status.js';
import { ENGINE_VERSION } from './version.js';

export * from './dates.js';
export * from './infer.js';
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
