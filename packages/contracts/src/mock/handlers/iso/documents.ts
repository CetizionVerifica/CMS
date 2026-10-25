// Mock handlers for the ISO add-on: Controlled documents and their revisions (model §3.4, §4.2).
// The server answers 403 FEATURE_NOT_ENABLED or 409 FEATURE_NOT_READY before any of these run.
import type { PartialHandlers } from '../../handler.js';
import { notYet } from './stub.js';

type Ids =
  | 'listIsoDocuments'
  | 'createIsoDocument'
  | 'getIsoDocument'
  | 'updateIsoDocument'
  | 'reviewIsoDocument'
  | 'obsoleteIsoDocument'
  | 'listIsoRevisions'
  | 'draftIsoRevision'
  | 'updateIsoRevision'
  | 'submitIsoRevision'
  | 'approveIsoRevision'
  | 'sendBackIsoRevision'
  | 'recordIsoEdition';

export const documentsHandlers: PartialHandlers<Ids> = {
  listIsoDocuments: notYet('listIsoDocuments'),

  createIsoDocument: notYet('createIsoDocument'),

  getIsoDocument: notYet('getIsoDocument'),

  updateIsoDocument: notYet('updateIsoDocument'),

  reviewIsoDocument: notYet('reviewIsoDocument'),

  obsoleteIsoDocument: notYet('obsoleteIsoDocument'),

  listIsoRevisions: notYet('listIsoRevisions'),

  draftIsoRevision: notYet('draftIsoRevision'),

  updateIsoRevision: notYet('updateIsoRevision'),

  submitIsoRevision: notYet('submitIsoRevision'),

  approveIsoRevision: notYet('approveIsoRevision'),

  sendBackIsoRevision: notYet('sendBackIsoRevision'),

  recordIsoEdition: notYet('recordIsoEdition'),
};
