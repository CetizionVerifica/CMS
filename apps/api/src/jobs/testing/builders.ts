import { randomUUID } from 'node:crypto';
import type { ClientRef, JobDeps } from '../ports.js';
import {
  captureMailer,
  memoryStore,
  type CaptureMailer,
  type MemoryAssignment,
  type MemoryFirm,
  type MemoryInstance,
  type MemoryPerson,
  type MemoryStore,
  type MemoryStoreHooks,
} from './memory-store.js';
import type { LocalDate } from '@canopy/contracts';

export const APP_URL = 'https://app.planetpulse.example';

export function person(overrides: Partial<MemoryPerson> = {}): MemoryPerson {
  return {
    id: randomUUID(),
    displayName: 'Asha Rao',
    email: 'asha@example.com',
    status: 'ACTIVE',
    clientIds: [],
    ...overrides,
  };
}

/** A monthly "day 7 of the following month" obligation (TDS deposit) assigned to one unit. */
export function assignment(
  client: ClientRef,
  owner: MemoryPerson,
  approver: MemoryPerson,
  overrides: Partial<MemoryAssignment> = {},
): MemoryAssignment {
  return {
    assignmentId: randomUUID(),
    assignmentVersion: 1,
    clientId: client.id,
    applicability: 'APPLICABLE',
    activeFrom: '2020-04-01' as LocalDate,
    activeTo: null,
    ownerId: owner.id,
    approverId: approver.id,
    obligationId: randomUUID(),
    recurrenceRule: { kind: 'MONTHLY', day: 7, offsetMonths: 1 },
    ruleStatus: 'CONFIRMED',
    title: 'Deposit TDS for the month',
    actName: 'Income Tax Act, 1961',
    unitName: 'Plant',
    departmentName: 'Finance',
    criticality: 'CRITICAL',
    ...overrides,
  };
}

export function instance(
  a: MemoryAssignment,
  dueDate: string,
  overrides: Partial<MemoryInstance> = {},
): MemoryInstance {
  return {
    id: randomUUID(),
    assignmentId: a.assignmentId,
    clientId: a.clientId,
    periodStart: dueDate as LocalDate,
    periodEnd: dueDate as LocalDate,
    dueDate: dueDate as LocalDate,
    workflowState: 'OPEN',
    pendingKind: null,
    completedOn: null,
    ownerId: a.ownerId,
    approverId: a.approverId,
    archived: false,
    ...overrides,
  };
}

export interface Harness {
  deps: JobDeps;
  store: MemoryStore;
  mailer: CaptureMailer;
  /** Sets the job clock. */
  at(instant: string): void;
}

export function harness(firms: MemoryFirm[], hooks: MemoryStoreHooks = {}): Harness {
  let now = '2026-10-12T01:30:00.000Z';
  const store = memoryStore(firms, hooks);
  const mailer = captureMailer();
  return {
    store,
    mailer,
    deps: { store, mailer, clock: () => now, appUrl: APP_URL },
    at: (instant) => void (now = instant),
  };
}
