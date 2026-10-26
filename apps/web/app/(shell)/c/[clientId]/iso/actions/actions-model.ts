// The actions list's URL state, API query and subject names (packages.md ISO-6b, model §3.12). The filters are the
// API's own query names, the ones the ISO overview's action counts link with included.
import {
  IsoActionState,
  IsoActionSubjectType,
  type IsoActionView,
  type ObjectiveView,
  type RiskItemView,
} from '@canopy/contracts';
import type { FilterDef } from '@canopy/ui';

import { first, listParam } from '../_lib/people';
import { WORDS } from '../_lib/words';

type Search = Record<string, string | string[] | undefined>;

export type ActionFilters = {
  /** The API takes one subject type; several chosen are matched on the page (they are labels, not records). */
  subjectType: IsoActionSubjectType[];
  ownerId?: 'me';
  state: IsoActionState[];
  overdue?: 'true';
  managementSystemId?: string;
  q?: string;
};

export function actionFilters(search: Search, systemIds: readonly string[]): ActionFilters {
  const q = first(search.q)?.trim().slice(0, 200);
  const system = first(search.managementSystemId);
  return {
    subjectType: listParam(
      search.subjectType,
      IsoActionSubjectType.options,
    ) as IsoActionSubjectType[],
    ...(first(search.ownerId) === 'me' ? { ownerId: 'me' as const } : {}),
    state: listParam(search.state, IsoActionState.options) as IsoActionState[],
    ...(first(search.overdue) === 'true' ? { overdue: 'true' as const } : {}),
    ...(system && systemIds.includes(system) ? { managementSystemId: system } : {}),
    ...(q ? { q } : {}),
  };
}

export function actionsQuery(f: ActionFilters): Record<string, string> {
  const query: Record<string, string> = {};
  if (f.subjectType.length === 1) query.subjectType = f.subjectType[0]!;
  if (f.ownerId) query.ownerId = f.ownerId;
  if (f.state.length) query.state = f.state.join(',');
  if (f.overdue) query.overdue = f.overdue;
  if (f.managementSystemId) query.managementSystemId = f.managementSystemId;
  if (f.q) query.q = f.q;
  return query;
}

/** Several subject types chosen: the API was asked for all, so keep the chosen ones. One or none: the API filtered. */
export function bySubjectType<T extends Pick<IsoActionView, 'subject'>>(
  actions: readonly T[],
  f: ActionFilters,
): T[] {
  return f.subjectType.length > 1
    ? actions.filter((a) => f.subjectType.includes(a.subject.type))
    : [...actions];
}

export function actionFilterDefs(): FilterDef[] {
  return [
    {
      key: 'subjectType',
      label: 'For',
      kind: 'multi',
      order: 'given',
      options: IsoActionSubjectType.options.map((v) => ({
        value: v,
        label: WORDS.IsoActionSubjectType[v],
      })),
    },
    {
      key: 'state',
      label: 'State',
      kind: 'multi',
      order: 'given',
      options: IsoActionState.options.map((v) => ({ value: v, label: WORDS.IsoActionState[v] })),
    },
    {
      key: 'overdue',
      label: 'Timing',
      kind: 'multi',
      options: [{ value: 'true', label: 'Overdue' }],
    },
    { key: 'ownerId', label: 'Owner', kind: 'multi', options: [{ value: 'me', label: 'Mine' }] },
  ];
}

export function actionFilterValue(f: ActionFilters): Record<string, string[]> {
  return {
    subjectType: f.subjectType,
    state: f.state,
    overdue: f.overdue ? [f.overdue] : [],
    ownerId: f.ownerId ? [f.ownerId] : [],
  };
}

/** What an action is for: its subject's name and page, where this package has one. */
export type ActionSubject = {
  label: string;
  href: string | null;
  /** A risk item not archived, an objective not closed; other subjects' state is their own page's. */
  open: boolean;
  /** A hazard's actions name their control's kind. */
  hierarchy?: 'required' | 'optional';
};

export function actionSubjects(
  clientId: string,
  actions: readonly Pick<IsoActionView, 'subject'>[],
  risks: readonly Pick<RiskItemView, 'id' | 'kind' | 'activity' | 'description' | 'archivedAt'>[],
  objectives: readonly Pick<ObjectiveView, 'id' | 'text' | 'closedOn'>[],
): Record<string, ActionSubject> {
  const out: Record<string, ActionSubject> = {};
  for (const { subject } of actions) {
    if (out[subject.id]) continue;
    if (subject.type === 'RISK_ITEM') {
      const r = risks.find((x) => x.id === subject.id);
      out[subject.id] = r
        ? {
            label: `${WORDS.RiskKind[r.kind]}: ${r.activity}, ${r.description.slice(0, 80)}`,
            href: `/c/${clientId}/iso/risks/${r.id}`,
            open: r.archivedAt === null,
            hierarchy: r.kind === 'HAZARD' ? 'required' : 'optional',
          }
        : { label: 'A risk item', href: null, open: true, hierarchy: 'optional' };
    } else if (subject.type === 'OBJECTIVE') {
      const o = objectives.find((x) => x.id === subject.id);
      out[subject.id] = o
        ? {
            label: `Objective: ${o.text.slice(0, 100)}`,
            href: `/c/${clientId}/iso/objectives/${o.id}`,
            open: o.closedOn === null,
          }
        : { label: 'An objective', href: null, open: true };
    } else {
      out[subject.id] = { label: WORDS.IsoActionSubjectType[subject.type], href: null, open: true };
    }
  }
  return out;
}
