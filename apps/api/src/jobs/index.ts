// Background jobs (MODULES.md M9): instance generation, reminders and escalations, the consultant digest.
export { clientDay, currentAndNextFy, reminderWindow, sendTimeReached } from './client-day.js';
export { CONSULTANT_DIGEST, runConsultantDigest } from './digest.js';
export {
  GENERATE_INSTANCES,
  memoisedGenerator,
  runGenerateInstances,
  skipReason,
} from './generate-instances.js';
export type * from './ports.js';
export { postgresJobStore } from './postgres-store.js';
export { REMINDERS, runReminders } from './reminders.js';
export {
  JOBS,
  startJobRunner,
  type JobDefinition,
  type JobRunner,
  type JobRunnerOptions,
} from './runner.js';
