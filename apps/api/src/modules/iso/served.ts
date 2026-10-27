import type { ENDPOINTS } from '@canopy/contracts';

/**
 * The ISO add-on endpoints M16 serves so far, by contract id (ISO-8a's and ISO-8b's; ISO-8c adds its own): those always
 * mounted, and the file routes, mounted only when the server is given an `IsoFiles` (ISO-15 wires it). M14's security
 * spec (`e2e/integrated/04-security.spec.ts`) reads them to sweep these routes and keep the rest on its unmounted list.
 * `served.test.ts` holds them equal to the routes `registerIsoRoutes` mounts. No imports beyond contract types, so the
 * e2e package can load this file on its own.
 */
export const ISO_SERVED_ENDPOINTS = [
  'approveIsoClauseNa',
  'approveIsoRevision',
  'archiveIsoContextItem',
  'archiveIsoRisk',
  'archiveIsoRiskControl',
  'cancelIsoAction',
  'cancelIsoExternalAudit',
  'closeIsoObjective',
  'completeIsoAction',
  'createIsoAction',
  'createIsoCertification',
  'createIsoContextItem',
  'createIsoDocument',
  'createIsoExternalAudit',
  'createIsoObjective',
  'createIsoReading',
  'createIsoRisk',
  'createIsoRiskControl',
  'createIsoSystem',
  'draftIsoRevision',
  'getIsoAction',
  'getIsoDocument',
  'getIsoExternalAudit',
  'getIsoObjective',
  'getIsoRisk',
  'getIsoSystem',
  'listIsoActions',
  'listIsoCertifications',
  'listIsoChecklist',
  'listIsoClauses',
  'listIsoContextItems',
  'listIsoDocuments',
  'listIsoExternalAudits',
  'listIsoObjectives',
  'listIsoReadings',
  'listIsoReviewDefs',
  'listIsoRevisions',
  'listIsoRiskControls',
  'listIsoRisks',
  'listIsoStandards',
  'listIsoSystems',
  'obsoleteIsoDocument',
  'recordIsoEdition',
  'recordIsoExternalAuditHeld',
  'rejectIsoClauseNa',
  'reopenIsoAction',
  'requestIsoClauseNa',
  'reviewIsoDocument',
  'reviewIsoRisk',
  'sendBackIsoRevision',
  'setIsoClimateDecision',
  'setIsoRiskSignificance',
  'submitIsoRevision',
  'updateIsoAction',
  'updateIsoCertification',
  'updateIsoChecklistRow',
  'updateIsoContextItem',
  'updateIsoDocument',
  'updateIsoExternalAudit',
  'updateIsoObjective',
  'updateIsoReading',
  'updateIsoRevision',
  'updateIsoRisk',
  'updateIsoRiskControl',
  'updateIsoSystem',
  'withdrawIsoClauseNa',
] as const satisfies readonly (keyof typeof ENDPOINTS)[];

/** Mounted only with an `IsoFiles`. */
export const ISO_FILE_ENDPOINTS = [
  'confirmIsoFile',
  'isoFileDownloadUrl',
  'isoFileUploadUrl',
  'listIsoFiles',
  'removeIsoFile',
] as const satisfies readonly (keyof typeof ENDPOINTS)[];

export type IsoServedEndpoint = (typeof ISO_SERVED_ENDPOINTS | typeof ISO_FILE_ENDPOINTS)[number];
