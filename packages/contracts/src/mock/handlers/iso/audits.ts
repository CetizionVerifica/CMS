// Mock handlers for the ISO add-on: Audit programmes, internal audits, their checklists and findings (model §3.7, §3.9, §4.3).
// The server answers 403 FEATURE_NOT_ENABLED or 409 FEATURE_NOT_READY before any of these run.
import type { PartialHandlers } from '../../handler.js';
import { notYet } from './stub.js';

type Ids =
  | 'listIsoAuditProgrammes'
  | 'createIsoAuditProgramme'
  | 'updateIsoAuditProgramme'
  | 'listIsoInternalAudits'
  | 'createIsoInternalAudit'
  | 'getIsoInternalAudit'
  | 'updateIsoInternalAudit'
  | 'startIsoInternalAudit'
  | 'reportIsoInternalAudit'
  | 'closeIsoInternalAudit'
  | 'cancelIsoInternalAudit'
  | 'listIsoAuditChecklist'
  | 'createIsoAuditChecklistItem'
  | 'updateIsoAuditChecklistItem'
  | 'listIsoInternalFindings'
  | 'createIsoInternalFinding'
  | 'updateIsoInternalFinding';

export const auditsHandlers: PartialHandlers<Ids> = {
  listIsoAuditProgrammes: notYet('listIsoAuditProgrammes'),

  createIsoAuditProgramme: notYet('createIsoAuditProgramme'),

  updateIsoAuditProgramme: notYet('updateIsoAuditProgramme'),

  listIsoInternalAudits: notYet('listIsoInternalAudits'),

  createIsoInternalAudit: notYet('createIsoInternalAudit'),

  getIsoInternalAudit: notYet('getIsoInternalAudit'),

  updateIsoInternalAudit: notYet('updateIsoInternalAudit'),

  startIsoInternalAudit: notYet('startIsoInternalAudit'),

  reportIsoInternalAudit: notYet('reportIsoInternalAudit'),

  closeIsoInternalAudit: notYet('closeIsoInternalAudit'),

  cancelIsoInternalAudit: notYet('cancelIsoInternalAudit'),

  listIsoAuditChecklist: notYet('listIsoAuditChecklist'),

  createIsoAuditChecklistItem: notYet('createIsoAuditChecklistItem'),

  updateIsoAuditChecklistItem: notYet('updateIsoAuditChecklistItem'),

  listIsoInternalFindings: notYet('listIsoInternalFindings'),

  createIsoInternalFinding: notYet('createIsoInternalFinding'),

  updateIsoInternalFinding: notYet('updateIsoInternalFinding'),
};
