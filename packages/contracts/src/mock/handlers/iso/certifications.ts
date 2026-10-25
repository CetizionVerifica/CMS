// Mock handlers for the ISO add-on: Certificates, external audits and their findings (model §3.8, §3.9, §4.4).
// The server answers 403 FEATURE_NOT_ENABLED or 409 FEATURE_NOT_READY before any of these run.
import type { PartialHandlers } from '../../handler.js';
import { notYet } from './stub.js';

type Ids =
  | 'listIsoCertifications'
  | 'createIsoCertification'
  | 'updateIsoCertification'
  | 'listIsoExternalAudits'
  | 'createIsoExternalAudit'
  | 'getIsoExternalAudit'
  | 'updateIsoExternalAudit'
  | 'recordIsoExternalAuditHeld'
  | 'recordIsoExternalAuditResponse'
  | 'closeIsoExternalAudit'
  | 'cancelIsoExternalAudit'
  | 'listIsoExternalFindings'
  | 'createIsoExternalFinding'
  | 'updateIsoExternalFinding';

export const certificationsHandlers: PartialHandlers<Ids> = {
  listIsoCertifications: notYet('listIsoCertifications'),

  createIsoCertification: notYet('createIsoCertification'),

  updateIsoCertification: notYet('updateIsoCertification'),

  listIsoExternalAudits: notYet('listIsoExternalAudits'),

  createIsoExternalAudit: notYet('createIsoExternalAudit'),

  getIsoExternalAudit: notYet('getIsoExternalAudit'),

  updateIsoExternalAudit: notYet('updateIsoExternalAudit'),

  recordIsoExternalAuditHeld: notYet('recordIsoExternalAuditHeld'),

  recordIsoExternalAuditResponse: notYet('recordIsoExternalAuditResponse'),

  closeIsoExternalAudit: notYet('closeIsoExternalAudit'),

  cancelIsoExternalAudit: notYet('cancelIsoExternalAudit'),

  listIsoExternalFindings: notYet('listIsoExternalFindings'),

  createIsoExternalFinding: notYet('createIsoExternalFinding'),

  updateIsoExternalFinding: notYet('updateIsoExternalFinding'),
};
