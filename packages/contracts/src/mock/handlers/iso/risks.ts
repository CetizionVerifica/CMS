// Mock handlers for the ISO add-on: Risk items and controls, objectives and readings (model §3.5, §3.6).
// The server answers 403 FEATURE_NOT_ENABLED or 409 FEATURE_NOT_READY before any of these run.
import type { PartialHandlers } from '../../handler.js';
import { notYet } from './stub.js';

type Ids =
  | 'listIsoRisks'
  | 'createIsoRisk'
  | 'getIsoRisk'
  | 'updateIsoRisk'
  | 'archiveIsoRisk'
  | 'reviewIsoRisk'
  | 'setIsoRiskSignificance'
  | 'listIsoRiskControls'
  | 'createIsoRiskControl'
  | 'updateIsoRiskControl'
  | 'archiveIsoRiskControl'
  | 'listIsoObjectives'
  | 'createIsoObjective'
  | 'getIsoObjective'
  | 'updateIsoObjective'
  | 'closeIsoObjective'
  | 'listIsoReadings'
  | 'createIsoReading'
  | 'updateIsoReading';

export const risksHandlers: PartialHandlers<Ids> = {
  listIsoRisks: notYet('listIsoRisks'),

  createIsoRisk: notYet('createIsoRisk'),

  getIsoRisk: notYet('getIsoRisk'),

  updateIsoRisk: notYet('updateIsoRisk'),

  archiveIsoRisk: notYet('archiveIsoRisk'),

  reviewIsoRisk: notYet('reviewIsoRisk'),

  setIsoRiskSignificance: notYet('setIsoRiskSignificance'),

  listIsoRiskControls: notYet('listIsoRiskControls'),

  createIsoRiskControl: notYet('createIsoRiskControl'),

  updateIsoRiskControl: notYet('updateIsoRiskControl'),

  archiveIsoRiskControl: notYet('archiveIsoRiskControl'),

  listIsoObjectives: notYet('listIsoObjectives'),

  createIsoObjective: notYet('createIsoObjective'),

  getIsoObjective: notYet('getIsoObjective'),

  updateIsoObjective: notYet('updateIsoObjective'),

  closeIsoObjective: notYet('closeIsoObjective'),

  listIsoReadings: notYet('listIsoReadings'),

  createIsoReading: notYet('createIsoReading'),

  updateIsoReading: notYet('updateIsoReading'),
};
