import { describe, expect, it } from 'vitest';

import { mayCall } from './may';

describe('mayCall (the contracts endpoint table, plan §3.2)', () => {
  it('lets managers set up a system, and nobody else', () => {
    expect(mayCall('updateIsoSystem', ['CONSULTANT'])).toBe(true);
    expect(mayCall('updateIsoSystem', ['CLIENT_ADMIN'])).toBe(true);
    expect(mayCall('updateIsoSystem', ['OWNER'], true)).toBe(false);
    expect(mayCall('updateIsoSystem', ['VIEWER'])).toBe(false);
  });

  it('lets an owner edit only a checklist row they own', () => {
    expect(mayCall('updateIsoChecklistRow', ['OWNER'])).toBe(false);
    expect(mayCall('updateIsoChecklistRow', ['OWNER'], true)).toBe(true);
    expect(mayCall('updateIsoChecklistRow', ['APPROVER'], true)).toBe(false);
  });

  it('reads any of several roles', () => {
    expect(mayCall('createIsoCertification', ['VIEWER', 'FIRM_ADMIN'])).toBe(true);
    expect(mayCall('createIsoCertification', [])).toBe(false);
  });
});
