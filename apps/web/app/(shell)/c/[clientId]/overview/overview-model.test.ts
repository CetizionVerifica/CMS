import { Breakdown, ClientOverview, InstanceRow } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';

import {
  actRows,
  deadlineItems,
  departmentRows,
  greeting,
  kpis,
  overviewModel,
  registerHref,
  taskItems,
} from './overview-model';
import { breakdown, CLIENT, id, instance, overview, result } from './test-data';

const reg = `/c/${CLIENT}/register`;
const Q3 = { fy: '2022-23', quarter: 3 as const };
const crit = (superCriticalOverdue: number) =>
  breakdown('criticality', [
    {
      key: 'SUPER_CRITICAL',
      label: 'Super critical',
      result: result({ OVERDUE: superCriticalOverdue }),
    },
    { key: 'HIGH', label: 'High', result: result({ OVERDUE: 3 }) },
  ]);

describe('test data', () => {
  it('builds contract-valid responses', () => {
    expect(InstanceRow.safeParse(instance(1)).success).toBe(true);
    expect(ClientOverview.safeParse(overview(result({ OVERDUE: 2 }), [instance(1)])).success).toBe(
      true,
    );
    expect(Breakdown.safeParse(crit(1)).success).toBe(true);
  });
});

describe('registerHref', () => {
  it('builds the filter language and carries the period', () => {
    expect(registerHref(CLIENT, { status: 'OVERDUE' }, Q3)).toBe(
      `${reg}?status=OVERDUE&fy=2022-23&q=Q3`,
    );
    expect(registerHref(CLIENT, { status: 'OVERDUE,DUE_SOON' })).toBe(
      `${reg}?status=OVERDUE%2CDUE_SOON`,
    );
  });

  it('leaves the query off when there is nothing to filter', () => {
    expect(registerHref(CLIENT, {}, undefined, 'calendar')).toBe(`/c/${CLIENT}/calendar`);
  });
});

describe('greeting', () => {
  it('states the overdue count and how many are super critical', () => {
    expect(greeting(result({ OVERDUE: 5 }), crit(2))).toBe(
      '5 items are overdue, 2 are super critical.',
    );
    expect(greeting(result({ OVERDUE: 5 }), crit(1))).toBe(
      '5 items are overdue, 1 is super critical.',
    );
    expect(greeting(result({ OVERDUE: 1 }), crit(1))).toBe(
      '1 item is overdue, and it is super critical.',
    );
  });

  it('leaves out the super critical part when there are none or no breakdown', () => {
    expect(greeting(result({ OVERDUE: 4 }), crit(0))).toBe('4 items are overdue.');
    expect(greeting(result({ OVERDUE: 1 }), undefined)).toBe('1 item is overdue.');
  });

  it('turns to approvals when nothing is overdue', () => {
    expect(greeting(result({ SUBMITTED: 3, UPCOMING: 2 }), crit(0))).toBe(
      'Nothing is overdue. 3 items are awaiting approval.',
    );
    expect(greeting(result({ SUBMITTED: 1 }), undefined)).toBe(
      'Nothing is overdue. 1 item is awaiting approval.',
    );
  });

  it('says when nothing is due, and when all is on track', () => {
    expect(greeting(result({ NOT_APPLICABLE: 2 }), undefined)).toBe(
      'Nothing is due in this period.',
    );
    expect(greeting(result({ UPCOMING: 4, COMPLIED: 2 }), undefined)).toBe('Nothing is overdue.');
    expect(greeting(result({ COMPLIED: 2 }), undefined)).toBe('Nothing is overdue.');
  });
});

describe('kpis', () => {
  it('shows the API numbers with links filtered to exactly those rows', () => {
    const cards = kpis(
      CLIENT,
      result(
        { UPCOMING: 4, DUE_SOON: 2, OVERDUE: 5, SUBMITTED: 3, COMPLIED: 10, COMPLIED_LATE: 1 },
        51.5,
        80,
      ),
      Q3,
      crit(2),
    );
    expect(cards.map((c) => [c.label, c.value, c.href])).toEqual([
      ['Compliance score', 51.5, `${reg}?status=COMPLIED%2CCOMPLIED_LATE&fy=2022-23&q=Q3`],
      ['Open', 11, `${reg}?status=UPCOMING%2CDUE_SOON%2COVERDUE&fy=2022-23&q=Q3`],
      ['Overdue', 5, `${reg}?status=OVERDUE&fy=2022-23&q=Q3`],
      ['Awaiting approval', 3, `${reg}?status=SUBMITTED&fy=2022-23&q=Q3`],
    ]);
    expect(cards[0]).toMatchObject({
      unit: '%',
      score: 51.5,
      linkHint: 'Open the 11 complied instances',
    });
    expect(cards[0]!.context).toBeUndefined();
    expect(cards[2]!.context).toEqual({ text: 'Needs action', tone: 'crit' });
    expect(cards[3]!.context).toBeUndefined();
  });

  it('gives every second number its own link to exactly its rows', () => {
    const cards = kpis(
      CLIENT,
      result({ DUE_SOON: 2, OVERDUE: 5, COMPLIED: 10, COMPLIED_LATE: 1 }, 51.5, 80),
      Q3,
      crit(2),
    );
    expect(cards.map((c) => c.detail)).toEqual([
      {
        text: '80% complied on time',
        tone: 'neutral',
        href: `${reg}?status=COMPLIED&fy=2022-23&q=Q3`,
        label: '80% complied on time, open the instances complied on time',
      },
      {
        text: '2 due soon',
        tone: 'warn',
        href: `${reg}?status=DUE_SOON&fy=2022-23&q=Q3`,
        label: '2 due soon, open the instances due soon',
      },
      {
        text: '2 super critical',
        tone: 'crit',
        href: `${reg}?status=OVERDUE&criticality=SUPER_CRITICAL&fy=2022-23&q=Q3`,
        label: '2 super critical overdue, open these instances',
      },
      undefined,
    ]);
  });

  it('words an empty score and calm counts', () => {
    const cards = kpis(CLIENT, result({ COMPLIED: 1 }), undefined, undefined);
    expect(cards[0]).toMatchObject({
      value: 'No items due',
      unit: undefined,
      score: null,
      linkHint: 'Open the 1 complied instance',
    });
    expect(cards.map((c) => c.detail)).toEqual([undefined, undefined, undefined, undefined]);
    expect(cards[0]!.context).toBeUndefined();
    expect(cards[1]!.context).toBeUndefined();
    expect(cards[2]!.context).toEqual({ text: 'None overdue', tone: 'ok' });
  });

  it('says overdue items need action when none are super critical', () => {
    expect(kpis(CLIENT, result({ OVERDUE: 2 }), undefined, crit(0))[2]!.context).toEqual({
      text: 'Needs action',
      tone: 'crit',
    });
  });
});

describe('departmentRows', () => {
  const b = breakdown('department', [
    { key: id(1), label: 'IT', result: result({ COMPLIED: 4 }, 90) },
    { key: id(2), label: 'EHS', result: result({ OVERDUE: 2, COMPLIED: 1, COMPLIED_LATE: 1 }, 40) },
    { key: id(3), label: 'Admin', result: result({}, null) },
    { key: id(4), label: 'HR', result: result({ COMPLIED: 1 }, 40) },
  ]);

  it('orders by overdue, then lowest score, then name, with no score last', () => {
    expect(departmentRows(CLIENT, b, undefined).map((r) => r.name)).toEqual([
      'EHS',
      'HR',
      'IT',
      'Admin',
    ]);
  });

  it('links the row and its overdue and complied counts to the department in the register', () => {
    const [ehs] = departmentRows(CLIENT, b, Q3);
    expect(ehs).toEqual({
      id: id(2),
      name: 'EHS',
      score: 40,
      complied: 2,
      overdue: 2,
      href: `${reg}?departmentId=${id(2)}&fy=2022-23&q=Q3`,
      overdueHref: `${reg}?departmentId=${id(2)}&status=OVERDUE&fy=2022-23&q=Q3`,
      compliedHref: `${reg}?departmentId=${id(2)}&status=COMPLIED%2CCOMPLIED_LATE&fy=2022-23&q=Q3`,
    });
  });
});

describe('actRows', () => {
  it('splits each Act into complied, pending, overdue and not applicable, most overdue first', () => {
    const act = `${reg}?actId=${id(6)}`;
    const q3 = 'fy=2022-23&q=Q3';
    const rows = actRows(
      CLIENT,
      breakdown('act', [
        { key: id(5), label: 'Water Act, 1974', result: result({ COMPLIED: 1 }) },
        {
          key: id(6),
          label: 'Factories Act, 1948',
          result: result({
            COMPLIED: 5,
            COMPLIED_LATE: 1,
            UPCOMING: 2,
            DUE_SOON: 1,
            SUBMITTED: 1,
            OVERDUE: 2,
            NOT_APPLICABLE: 3,
          }),
        },
        { key: id(7), label: 'ESI Act, 1948', result: result({ COMPLIED: 1 }) },
      ]),
      Q3,
    );
    expect(rows.map((r) => r.name)).toEqual([
      'Factories Act, 1948',
      'ESI Act, 1948',
      'Water Act, 1974',
    ]);
    expect(rows[0]).toEqual({
      id: id(6),
      name: 'Factories Act, 1948',
      segments: [
        {
          key: 'ok',
          label: 'Complied',
          count: 6,
          href: `${act}&status=COMPLIED%2CCOMPLIED_LATE&${q3}`,
        },
        {
          key: 'warn',
          label: 'Pending',
          count: 4,
          href: `${act}&status=UPCOMING%2CDUE_SOON%2CSUBMITTED&${q3}`,
        },
        { key: 'crit', label: 'Overdue', count: 2, href: `${act}&status=OVERDUE&${q3}` },
        {
          key: 'neutral',
          label: 'Not applicable',
          count: 3,
          href: `${act}&status=NOT_APPLICABLE&${q3}`,
        },
      ],
      href: `${act}&${q3}`,
    });
  });
});

describe('instance lists', () => {
  const late = instance(1, { status: 'OVERDUE', overdueDays: 4, title: 'Fire drill record' });
  const soon = instance(2);

  it('makes deadline items that open the instance drawer', () => {
    expect(deadlineItems([late, soon], Q3)).toEqual([
      {
        id: late.id,
        dueDate: '2023-03-20',
        title: 'Fire drill record',
        meta: 'EHS · Owner 01',
        status: 'OVERDUE',
        days: 4,
        href: `${reg}/${late.id}?fy=2022-23&q=Q3`,
      },
      expect.objectContaining({ id: soon.id, status: 'DUE_SOON', days: undefined }),
    ]);
  });

  it('makes task items with the Act as meta', () => {
    expect(taskItems([late])).toEqual([
      {
        id: late.id,
        title: 'Fire drill record',
        meta: 'Factories Act, 1948',
        dueDate: '2023-03-20',
        status: 'OVERDUE',
        days: 4,
        href: `${reg}/${late.id}`,
      },
    ]);
  });
});

describe('overviewModel', () => {
  it('puts the page together from the API responses', () => {
    const model = overviewModel({
      clientId: CLIENT,
      period: Q3,
      overview: overview(result({ OVERDUE: 1 }), [instance(1)], [instance(2)]),
      byDepartment: breakdown('department', []),
      byAct: breakdown('act', []),
    });
    expect(model).toMatchObject({
      greeting: '1 item is overdue.',
      departments: [],
      acts: [],
      today: '2023-03-15',
      calendarHref: `/c/${CLIENT}/calendar?fy=2022-23&q=Q3`,
      myItemsHref: `${reg}?ownerId=me&status=UPCOMING%2CDUE_SOON%2COVERDUE&fy=2022-23&q=Q3`,
    });
    expect(model.kpis).toHaveLength(4);
    expect(model.upcoming).toHaveLength(1);
    expect(model.myTasks).toHaveLength(1);
  });
});
