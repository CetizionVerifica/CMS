// Mock handlers for the ISO add-on: Catalogue reads, management systems, context, the clause checklist with N/A, and the overview.
// The server answers 403 FEATURE_NOT_ENABLED or 409 FEATURE_NOT_READY before any of these run.
import type { PartialHandlers } from '../../handler.js';
import { notYet } from './stub.js';

type Ids =
  | 'listIsoStandards'
  | 'listIsoClauses'
  | 'listIsoReviewDefs'
  | 'listIsoSystems'
  | 'createIsoSystem'
  | 'getIsoSystem'
  | 'updateIsoSystem'
  | 'setIsoClimateDecision'
  | 'listIsoContextItems'
  | 'createIsoContextItem'
  | 'updateIsoContextItem'
  | 'archiveIsoContextItem'
  | 'listIsoChecklist'
  | 'updateIsoChecklistRow'
  | 'requestIsoClauseNa'
  | 'approveIsoClauseNa'
  | 'rejectIsoClauseNa'
  | 'withdrawIsoClauseNa'
  | 'getIsoOverview';

export const systemsHandlers: PartialHandlers<Ids> = {
  listIsoStandards: notYet('listIsoStandards'),

  listIsoClauses: notYet('listIsoClauses'),

  listIsoReviewDefs: notYet('listIsoReviewDefs'),

  listIsoSystems: notYet('listIsoSystems'),

  createIsoSystem: notYet('createIsoSystem'),

  getIsoSystem: notYet('getIsoSystem'),

  updateIsoSystem: notYet('updateIsoSystem'),

  setIsoClimateDecision: notYet('setIsoClimateDecision'),

  listIsoContextItems: notYet('listIsoContextItems'),

  createIsoContextItem: notYet('createIsoContextItem'),

  updateIsoContextItem: notYet('updateIsoContextItem'),

  archiveIsoContextItem: notYet('archiveIsoContextItem'),

  listIsoChecklist: notYet('listIsoChecklist'),

  updateIsoChecklistRow: notYet('updateIsoChecklistRow'),

  requestIsoClauseNa: notYet('requestIsoClauseNa'),

  approveIsoClauseNa: notYet('approveIsoClauseNa'),

  rejectIsoClauseNa: notYet('rejectIsoClauseNa'),

  withdrawIsoClauseNa: notYet('withdrawIsoClauseNa'),

  getIsoOverview: notYet('getIsoOverview'),
};
