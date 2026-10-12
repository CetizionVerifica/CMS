import type { EngineApi } from '@canopy/contracts';
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
    expectTypeOf(api.engine).toExtend<Omit<EngineApi, 'planNotifications'>>();
  });
});
