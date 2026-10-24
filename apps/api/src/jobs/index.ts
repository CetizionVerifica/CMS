// Background jobs (MODULES.md M9): instance generation, reminders and escalations, the consultant digest, the
// evidence virus scan, and the nightly account job (trial end, usage snapshot).
export { ACCOUNT_DAILY, runAccountDaily, servedFirmIds } from './accounts.js';
export { clamAvConfigFromEnv, clamAvScanner, type ClamAvConfig } from './clamav-scanner.js';
export { clientDay, currentAndNextFy, reminderWindow, sendTimeReached } from './client-day.js';
export { activeConsumers, CONSUMERS, OutboxEventSchema, type Consumer } from './consumers.js';
export { CONSULTANT_DIGEST, runConsultantDigest } from './digest.js';
export {
  GENERATE_INSTANCES,
  generateForScope,
  type GenerationScope,
  memoisedGenerator,
  runGenerateInstances,
  skipReason,
} from './generate-instances.js';
export { RELAY_BATCH, RELAY_OUTBOX, runRelayOutbox } from './outbox-relay.js';
export type * from './ports.js';
export { ScanInterruptedError, ScanServiceError, ScanTimeoutError } from './ports.js';
export { postgresJobStore } from './postgres-store.js';
export { REMINDERS, runReminders } from './reminders.js';
export { runScanEvidence, SCAN_EVIDENCE } from './scan-evidence.js';
export { s3EvidenceObjects } from './s3-objects.js';
export {
  JOBS,
  startJobRunner,
  type JobDefinition,
  type JobRunner,
  type JobRunnerOptions,
} from './runner.js';
export { mailConfigFromEnv, smtpMailer, type MailConfig } from './smtp-mailer.js';
export { startJobsFromEnv, type JobsFromEnvOptions } from './start.js';
