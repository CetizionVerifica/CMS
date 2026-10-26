import type { ENDPOINTS } from '@canopy/contracts';

/**
 * The ISO add-on endpoints M16 serves so far, by contract id: ISO-8a's; ISO-8b and ISO-8c add theirs. M14's security
 * spec (`e2e/integrated/04-security.spec.ts`) reads it to sweep these routes and keep the rest on its unmounted list.
 * `served.test.ts` holds it equal to the routes `registerIsoRoutes` mounts. No imports beyond contract types, so the
 * e2e package can load it on its own.
 */
export const ISO_SERVED_ENDPOINTS = [
  'approveIsoClauseNa',
  'approveIsoRevision',
  'archiveIsoContextItem',
  'cancelIsoExternalAudit',
  'confirmIsoFile',
  'createIsoCertification',
  'createIsoContextItem',
  'createIsoDocument',
  'createIsoExternalAudit',
  'createIsoSystem',
  'draftIsoRevision',
  'getIsoDocument',
  'getIsoExternalAudit',
  'getIsoSystem',
  'isoFileDownloadUrl',
  'isoFileUploadUrl',
  'listIsoCertifications',
  'listIsoChecklist',
  'listIsoClauses',
  'listIsoContextItems',
  'listIsoDocuments',
  'listIsoExternalAudits',
  'listIsoFiles',
  'listIsoReviewDefs',
  'listIsoRevisions',
  'listIsoStandards',
  'listIsoSystems',
  'obsoleteIsoDocument',
  'recordIsoEdition',
  'recordIsoExternalAuditHeld',
  'rejectIsoClauseNa',
  'removeIsoFile',
  'requestIsoClauseNa',
  'reviewIsoDocument',
  'sendBackIsoRevision',
  'setIsoClimateDecision',
  'submitIsoRevision',
  'updateIsoCertification',
  'updateIsoChecklistRow',
  'updateIsoContextItem',
  'updateIsoDocument',
  'updateIsoExternalAudit',
  'updateIsoRevision',
  'updateIsoSystem',
  'withdrawIsoClauseNa',
] as const satisfies readonly (keyof typeof ENDPOINTS)[];

export type IsoServedEndpoint = (typeof ISO_SERVED_ENDPOINTS)[number];
