import type { LocalDate } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';

import { ISO } from '../_test/fixture';
import {
  actionFilterDefs,
  actionFilters,
  actionFilterValue,
  actionsQuery,
  actionSubjects,
  bySubjectType,
} from './actions-model';

const SYS = ISO.system.id;
const C = 'c1';

describe('action filters', () => {
  it("reads the overview's exact filters and sends them to the API", () => {
    expect(actionsQuery(actionFilters({ managementSystemId: SYS, state: 'OPEN' }, [SYS]))).toEqual({
      managementSystemId: SYS,
      state: 'OPEN',
    });
    expect(
      actionsQuery(actionFilters({ managementSystemId: SYS, overdue: 'true' }, [SYS])),
    ).toEqual({ managementSystemId: SYS, overdue: 'true' });
    const f = actionFilters(
      { subjectType: 'RISK_ITEM', ownerId: 'me', state: 'OPEN,DONE,BOGUS', q: ' tray ' },
      [SYS],
    );
    expect(actionsQuery(f)).toEqual({
      subjectType: 'RISK_ITEM',
      ownerId: 'me',
      state: 'OPEN,DONE',
      q: 'tray',
    });
    expect(actionFilterValue(f)).toEqual({
      subjectType: ['RISK_ITEM'],
      state: ['OPEN', 'DONE'],
      overdue: [],
      ownerId: ['me'],
    });
    expect(actionFilterDefs().map((d) => d.key)).toEqual([
      'subjectType',
      'state',
      'overdue',
      'ownerId',
    ]);
  });

  it('asks for every subject type when several are chosen, and keeps the chosen ones', () => {
    const f = actionFilters({ subjectType: 'RISK_ITEM,OBJECTIVE', managementSystemId: 'x' }, [SYS]);
    expect(actionsQuery(f)).toEqual({});
    const kept = bySubjectType(ISO.actions, f);
    expect(new Set(kept.map((a) => a.subject.type))).toEqual(new Set(['RISK_ITEM', 'OBJECTIVE']));
    const one = actionFilters({ subjectType: 'RISK_ITEM' }, [SYS]);
    expect(bySubjectType(ISO.actions, one)).toHaveLength(ISO.actions.length);
  });
});

describe('action subjects', () => {
  it('names each subject, linking risk items and objectives to their pages', () => {
    const subjects = actionSubjects(C, ISO.actions, ISO.risks, ISO.objectives);
    const of = (type: string) =>
      ISO.actions.filter((a) => a.subject.type === type).map((a) => subjects[a.subject.id]!);
    for (const s of of('RISK_ITEM')) {
      expect(s.href).toMatch(new RegExp(`^/c/${C}/iso/risks/`));
      expect(s.hierarchy).toBeDefined();
    }
    for (const s of of('OBJECTIVE')) {
      expect(s.href).toMatch(new RegExp(`^/c/${C}/iso/objectives/`));
      expect(s.label).toMatch(/^Objective: /);
    }
    expect(of('NONCONFORMITY')[0]).toEqual({ label: 'Corrective action', href: null, open: true });
    const hazard = ISO.risks.find((r) => r.kind === 'HAZARD')!;
    const closed = { ...ISO.objectives[0]!, closedOn: '2024-10-04' as LocalDate };
    const own = actionSubjects(
      C,
      [
        { subject: { type: 'RISK_ITEM', id: hazard.id } },
        { subject: { type: 'OBJECTIVE', id: closed.id } },
      ],
      [{ ...hazard, archivedAt: '2024-01-01T00:00:00Z' }],
      [closed],
    );
    expect(own[hazard.id]).toMatchObject({ open: false, hierarchy: 'required' });
    expect(own[closed.id]!.open).toBe(false);
  });

  it('names a subject the reader cannot list by its kind', () => {
    const subjects = actionSubjects(
      C,
      [{ subject: { type: 'RISK_ITEM', id: 'r' } }, { subject: { type: 'OBJECTIVE', id: 'o' } }],
      [],
      [],
    );
    expect(subjects.r).toEqual({
      label: 'A risk item',
      href: null,
      open: true,
      hierarchy: 'optional',
    });
    expect(subjects.o).toEqual({ label: 'An objective', href: null, open: true });
  });
});
