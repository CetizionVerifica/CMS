// Mock handlers for the ISO add-on: Management reviews with inputs and outputs (model §3.13, §4.5), and ISO files (model §6).
// The server answers 403 FEATURE_NOT_ENABLED or 409 FEATURE_NOT_READY before any of these run.
import type { PartialHandlers } from '../../handler.js';
import { notYet } from './stub.js';

type Ids =
  | 'listIsoManagementReviews'
  | 'planIsoManagementReview'
  | 'getIsoManagementReview'
  | 'updateIsoManagementReview'
  | 'cancelIsoManagementReview'
  | 'recordIsoManagementReviewHeld'
  | 'closeIsoManagementReview'
  | 'listIsoReviewInputs'
  | 'updateIsoReviewInput'
  | 'listIsoReviewOutputs'
  | 'updateIsoReviewOutput'
  | 'isoFileUploadUrl'
  | 'confirmIsoFile'
  | 'listIsoFiles'
  | 'isoFileDownloadUrl'
  | 'removeIsoFile';

export const reviewsHandlers: PartialHandlers<Ids> = {
  listIsoManagementReviews: notYet('listIsoManagementReviews'),

  planIsoManagementReview: notYet('planIsoManagementReview'),

  getIsoManagementReview: notYet('getIsoManagementReview'),

  updateIsoManagementReview: notYet('updateIsoManagementReview'),

  cancelIsoManagementReview: notYet('cancelIsoManagementReview'),

  recordIsoManagementReviewHeld: notYet('recordIsoManagementReviewHeld'),

  closeIsoManagementReview: notYet('closeIsoManagementReview'),

  listIsoReviewInputs: notYet('listIsoReviewInputs'),

  updateIsoReviewInput: notYet('updateIsoReviewInput'),

  listIsoReviewOutputs: notYet('listIsoReviewOutputs'),

  updateIsoReviewOutput: notYet('updateIsoReviewOutput'),

  isoFileUploadUrl: notYet('isoFileUploadUrl'),

  confirmIsoFile: notYet('confirmIsoFile'),

  listIsoFiles: notYet('listIsoFiles'),

  isoFileDownloadUrl: notYet('isoFileDownloadUrl'),

  removeIsoFile: notYet('removeIsoFile'),
};
