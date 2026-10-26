import type { EngineApi, IsoEngineApi } from '@canopy/contracts';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as api from '../src/index.js';

describe('package entry', () => {
  it('exposes the contract functions and the engine version', () => {
    expect(api.ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(api.engine).toEqual({
      generateInstances: api.generateInstances,
      inferRule: api.inferRule,
      deriveStatus: api.deriveStatus,
      computeScore: api.computeScore,
      planNotifications: api.planNotifications,
      ENGINE_VERSION: api.ENGINE_VERSION,
    });
    expectTypeOf(api.engine).toExtend<EngineApi>();
  });
  it('exposes the ISO engine functions as one IsoEngineApi object', () => {
    expect(api.isoEngine).toEqual({
      riskRating: api.riskRating,
      isSignificant: api.isSignificant,
      clauseReadiness: api.clauseReadiness,
      certificationReadiness: api.certificationReadiness,
      objectiveProgress: api.objectiveProgress,
      auditProgrammeCoverage: api.auditProgrammeCoverage,
      incidentCounts: api.incidentCounts,
      climateDeterminationGaps: api.climateDeterminationGaps,
      isoTransition: api.isoTransition,
      nonconformityStatus: api.nonconformityStatus,
      actionStatus: api.actionStatus,
      certificationCycle: api.certificationCycle,
      managementReviewDue: api.managementReviewDue,
      reviewDue: api.reviewDue,
      planIsoNotifications: api.planIsoNotifications,
      reviewInputFigures: api.reviewInputFigures,
    });
    expectTypeOf(api.isoEngine).toExtend<IsoEngineApi>();
  });
});
