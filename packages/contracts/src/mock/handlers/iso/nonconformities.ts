// Mock handlers for the ISO add-on: Nonconformities with incident fields, and ISO actions on every subject (model §3.10-3.12, §4.1).
// The server answers 403 FEATURE_NOT_ENABLED or 409 FEATURE_NOT_READY before any of these run.
import type { PartialHandlers } from '../../handler.js';
import { notYet } from './stub.js';

type Ids =
  | 'listIsoNonconformities'
  | 'raiseIsoNonconformity'
  | 'getIsoNonconformity'
  | 'updateIsoNonconformity'
  | 'addIsoNcRootCause'
  | 'planIsoNcActions'
  | 'submitIsoNcNoAction'
  | 'submitIsoNc'
  | 'verifyIsoNcEffective'
  | 'verifyIsoNcNotEffective'
  | 'cancelIsoNc'
  | 'reopenIsoNc'
  | 'listIsoActions'
  | 'createIsoAction'
  | 'getIsoAction'
  | 'updateIsoAction'
  | 'completeIsoAction'
  | 'cancelIsoAction'
  | 'reopenIsoAction';

export const nonconformitiesHandlers: PartialHandlers<Ids> = {
  listIsoNonconformities: notYet('listIsoNonconformities'),

  raiseIsoNonconformity: notYet('raiseIsoNonconformity'),

  getIsoNonconformity: notYet('getIsoNonconformity'),

  updateIsoNonconformity: notYet('updateIsoNonconformity'),

  addIsoNcRootCause: notYet('addIsoNcRootCause'),

  planIsoNcActions: notYet('planIsoNcActions'),

  submitIsoNcNoAction: notYet('submitIsoNcNoAction'),

  submitIsoNc: notYet('submitIsoNc'),

  verifyIsoNcEffective: notYet('verifyIsoNcEffective'),

  verifyIsoNcNotEffective: notYet('verifyIsoNcNotEffective'),

  cancelIsoNc: notYet('cancelIsoNc'),

  reopenIsoNc: notYet('reopenIsoNc'),

  listIsoActions: notYet('listIsoActions'),

  createIsoAction: notYet('createIsoAction'),

  getIsoAction: notYet('getIsoAction'),

  updateIsoAction: notYet('updateIsoAction'),

  completeIsoAction: notYet('completeIsoAction'),

  cancelIsoAction: notYet('cancelIsoAction'),

  reopenIsoAction: notYet('reopenIsoAction'),
};
