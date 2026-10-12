import { randomUUID } from 'node:crypto';
import { DEFAULT_CLIENT_SETTINGS, type Role } from '@canopy/contracts';
import { asLocalDate } from '@canopy/engine';
import { createTestAuth, type MembershipInput } from '../../auth/testing.js';
import { buildServer } from '../../server.js';
import { InProcessRunner } from '../reports/service.js';
import { MemoryExportFiles } from '../reports/files.js';
import { makeRow } from './fixtures.js';
import { MemoryReportsStore, type MemoryRow } from './memory-store.js';

/**
 * A small two-firm world for M10 route tests. "Today" is 2026-10-12 in Asia/Kolkata, so the current FY is
 * 2026-27. Client "Beta Group" (firm A) has units U1 and U2 with one row per derived status, plus one row in
 * the previous FY; "Alpha Group" (firm A) has one row; firm B's client has one row.
 */

export const NOW = new Date('2026-10-12T06:00:00Z');
const d = asLocalDate;

export function createWorld() {
  const store = new MemoryReportsStore(() => NOW);
  const files = new MemoryExportFiles();
  const runner = new InProcessRunner();
  const auth = createTestAuth();
  const app = buildServer({
    authStore: auth.store,
    clock: () => NOW,
    reports: { store, files, runner, exportRateLimit: { max: 1000, timeWindow: '1 minute' } },
  });

  const firmId = randomUUID();
  const otherFirmId = randomUUID();
  const clientId = randomUUID();
  const secondClientId = randomUUID();
  const otherFirmClientId = randomUUID();
  const unit1 = randomUUID();
  const unit2 = randomUUID();
  const ownerId = randomUUID();
  const approverId = randomUUID();
  const dept = { safety: randomUUID(), tax: randomUUID() };
  const act = { factories: randomUUID(), tax: randomUUID() };

  for (const [id, firm, name] of [
    [clientId, firmId, 'Beta Group'],
    [secondClientId, firmId, 'Alpha Group'],
    [otherFirmClientId, otherFirmId, 'Other Firm Client'],
  ] as const) {
    store.clientsById.set(id, { id, firmId: firm, name, settings: DEFAULT_CLIENT_SETTINGS });
  }
  for (const [id, name] of [
    [unit1, 'Plant'],
    [unit2, 'Head Office'],
  ] as const) {
    store.units.set(id, {
      id,
      firmId,
      clientId,
      name,
      companyName: 'Hindalco',
      locationLabel: 'India / West Bengal / Belur',
    });
  }

  const base = (unitId: string) => ({
    firmId,
    clientId,
    unitId,
    unitName: unitId === unit1 ? 'Plant' : 'Head Office',
  });
  const safety = { departmentId: dept.safety, departmentName: 'Safety' };
  const tax = { departmentId: dept.tax, departmentName: 'Tax' };
  const factories = { actId: act.factories, actName: 'Factories Act, 1948' };
  const taxAct = { actId: act.tax, actName: 'Income Tax Act, 1961' };
  const mine = { ownerId, ownerName: 'Person Owner' };
  const approved = { approverId, approverName: 'Person Approver' };

  const rows: Record<string, MemoryRow> = {
    overdue: makeRow({
      ...base(unit1),
      ...safety,
      ...factories,
      ...mine,
      ...approved,
      dueDate: d('2026-09-30'),
      criticality: 'SUPER_CRITICAL',
      comments: ['Waiting for the inspector'],
    }),
    dueSoon: makeRow({
      ...base(unit1),
      ...safety,
      ...factories,
      ...mine,
      ...approved,
      dueDate: d('2026-10-15'),
    }),
    complied: makeRow({
      ...base(unit1),
      ...tax,
      ...taxAct,
      ...approved,
      dueDate: d('2026-06-30'),
      workflowState: 'APPROVED',
      completedOn: d('2026-06-20'),
      criticality: 'LOW',
      firstComment: 'Challan attached',
      comments: ['Challan attached'],
      lastComment: 'Challan attached',
      commentCount: 1,
    }),
    compliedLate: makeRow({
      ...base(unit2),
      ...tax,
      ...taxAct,
      dueDate: d('2026-07-31'),
      workflowState: 'APPROVED',
      completedOn: d('2026-08-05'),
      evidenceCount: 2,
    }),
    submitted: makeRow({
      ...base(unit2),
      ...safety,
      ...factories,
      ...approved,
      dueDate: d('2026-11-30'),
      workflowState: 'SUBMITTED',
      pendingKind: 'COMPLETION',
      completedOn: d('2026-10-01'),
    }),
    notApplicable: makeRow({
      ...base(unit2),
      ...tax,
      ...taxAct,
      dueDate: d('2026-05-31'),
      workflowState: 'NOT_APPLICABLE',
      completedOn: d('2026-05-01'),
      naReason: 'We do not transport compressed gas',
    }),
    upcoming: makeRow({
      ...base(unit1),
      ...safety,
      ...factories,
      ...mine,
      dueDate: d('2027-02-28'),
      timelineType: 'ONGOING',
    }),
    sentBack: makeRow({
      ...base(unit2),
      ...safety,
      ...factories,
      ...mine,
      dueDate: d('2026-10-01'),
      workflowState: 'SENT_BACK',
    }),
    lastFy: makeRow({
      ...base(unit1),
      ...safety,
      ...factories,
      dueDate: d('2025-12-31'),
    }),
    secondClient: makeRow({ firmId, clientId: secondClientId, dueDate: d('2026-10-14') }),
    otherFirm: makeRow({ firmId: otherFirmId, clientId: otherFirmClientId }),
  };
  store.rows.push(...Object.values(rows));
  store.audit.push({
    firmId,
    clientId,
    at: '2026-10-11T10:00:00.000Z',
    actorId: ownerId,
    action: 'EXPORT',
    entityType: 'export',
    entityId: randomUUID(),
    after: {},
  });

  /** Signs in with one membership of `role` in the Beta Group client (or firm-wide for firm roles). */
  function as(role: Role, extra: Partial<MembershipInput> = {}, personId?: string) {
    const membership: MembershipInput =
      role === 'FIRM_ADMIN'
        ? { role }
        : role === 'CONSULTANT'
          ? { role, consultantClientIds: [clientId] }
          : { role, clientId };
    return auth.signIn({
      firmId,
      personId,
      memberships: [{ ...membership, ...extra }],
      principal: { firmClientIds: [clientId, secondClientId] },
    });
  }

  return {
    app,
    store,
    files,
    runner,
    auth,
    firmId,
    otherFirmId,
    clientId,
    secondClientId,
    otherFirmClientId,
    unit1,
    unit2,
    ownerId,
    approverId,
    dept,
    act,
    rows,
    as,
  };
}

export type World = ReturnType<typeof createWorld>;
