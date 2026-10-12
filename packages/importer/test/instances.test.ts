import type { LocalDate } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';
import {
  commentsToAppend,
  instanceAfterCommit,
  instanceChange,
  type ExistingInstance,
} from '../src/instances.js';
import type { PlanInstance } from '../src/types.js';

const day = (d: string) => d as LocalDate;

function planned(overrides: Partial<PlanInstance> = {}): PlanInstance {
  return {
    key: 'u|ref:X|hr|2023-04-30',
    assignmentKey: 'u|ref:X|hr',
    rowNumbers: [2],
    dueDate: day('2023-04-30'),
    workflowState: 'OPEN',
    completedOn: null,
    naReason: null,
    owner: 'asha rao',
    approver: 'vikram shah',
    comments: [],
    ...overrides,
  };
}

const stored = (overrides: Partial<ExistingInstance> = {}): ExistingInstance => ({
  ...instanceAfterCommit(planned(), undefined),
  ...overrides,
});

describe('commentsToAppend', () => {
  it('keeps incoming comments already present in order, wherever others sit between them', () => {
    expect(commentsToAppend(['a', 'b'], ['a', 'note', 'b'])).toEqual([]);
    expect(commentsToAppend([], ['a'])).toEqual([]);
  });

  it('appends comments that are missing or out of order', () => {
    expect(commentsToAppend(['a', 'c'], ['a', 'b'])).toEqual(['c']);
    expect(commentsToAppend(['b', 'a'], ['a', 'b'])).toEqual(['a']);
    expect(commentsToAppend(['a', 'a'], ['a'])).toEqual(['a']);
  });
});

describe('instanceChange', () => {
  it('is unchanged when the register matches the stored instance', () => {
    expect(instanceChange(planned(), stored())).toBeNull();
  });

  it('is unchanged when the incoming comments are already on the instance, in order', () => {
    const incoming = planned({ comments: ['Filed late', 'Receipt pending'] });
    const existing = stored({ comments: ['Filed late', 'Approver note', 'Receipt pending'] });
    expect(instanceChange(incoming, existing)).toBeNull();
  });

  it('appends only the new comments', () => {
    const incoming = planned({ comments: ['Filed late', 'Receipt pending'] });
    expect(instanceChange(incoming, stored({ comments: ['Filed late'] }))).toEqual({
      state: null,
      owner: null,
      approver: null,
      newComments: ['Receipt pending'],
    });
  });

  it.each(['SUBMITTED', 'SENT_BACK'] as const)(
    'leaves a %s instance alone when the register still says Pending with no Activity Date',
    (workflowState) => {
      expect(instanceChange(planned(), stored({ workflowState }))).toBeNull();
    },
  );

  it('approves a submitted instance the register shows as Complied', () => {
    const complied = planned({ workflowState: 'APPROVED', completedOn: day('2023-04-20') });
    expect(instanceChange(complied, stored({ workflowState: 'SUBMITTED' }))?.state).toEqual({
      workflowState: 'APPROVED',
      completedOn: '2023-04-20',
      naReason: null,
    });
  });

  it('changes state, owner and approver when they differ', () => {
    const na = planned({ workflowState: 'NOT_APPLICABLE', naReason: 'No such plant' });
    expect(instanceChange(na, stored({ owner: 'old owner', approver: 'old approver' }))).toEqual({
      state: { workflowState: 'NOT_APPLICABLE', completedOn: null, naReason: 'No such plant' },
      owner: 'asha rao',
      approver: 'vikram shah',
      newComments: [],
    });
  });

  it('reopens an approved instance the register shows as Pending', () => {
    const approved = stored({ workflowState: 'APPROVED', completedOn: day('2023-04-20') });
    expect(instanceChange(planned(), approved)?.state).toEqual({
      workflowState: 'OPEN',
      completedOn: null,
      naReason: null,
    });
  });
});

describe('instanceAfterCommit', () => {
  it('creates from the plan and applies changes to what exists', () => {
    const incoming = planned({ comments: ['Filed late'], owner: 'new owner' });
    expect(instanceAfterCommit(incoming, undefined)).toMatchObject({
      owner: 'new owner',
      comments: ['Filed late'],
    });
    const existing = stored({ workflowState: 'SUBMITTED', comments: ['Earlier'] });
    expect(instanceAfterCommit(incoming, existing)).toEqual({
      ...existing,
      owner: 'new owner',
      comments: ['Earlier', 'Filed late'],
    });
    expect(instanceAfterCommit(planned(), stored())).toEqual(stored());
  });
});
