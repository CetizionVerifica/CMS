// The internal audit programme's URL state, API query and rows (packages.md ISO-6c, model §3.7). The filters are the
// API's own query names, plus `fy`, which the page reads as the programmes of that FY; `ids` is the exact list an
// overview number counts and goes to the API's own filter, since the list is paged. Nothing here filters the rows.
import {
  InternalAuditState,
  selfAuditors,
  type AuditProgrammeView,
  type InternalAuditView,
  type ManagementSystem,
  type Unit,
} from '@canopy/contracts';
import type { FilterDef } from '@canopy/ui';

import { first, listParam, nameOf, namesOf, type PersonOption } from '../_lib/people';
import { WORDS } from '../_lib/words';

type Search = Record<string, string | string[] | undefined>;

export type AuditFilters = {
  state: InternalAuditState[];
  unitId: string[];
  leadAuditorId?: 'me';
  /** The programmes of these FYs. */
  fy: string[];
  managementSystemId?: string;
  q?: string;
  ids: string[];
};

const FY = /^\d{4}-\d{2}$/;

export function auditFilters(
  search: Search,
  systemIds: readonly string[],
  unitIds: readonly string[],
): AuditFilters {
  const q = first(search.q)?.trim().slice(0, 200);
  const system = first(search.managementSystemId);
  return {
    state: listParam(search.state, InternalAuditState.options) as InternalAuditState[],
    unitId: listParam(search.unitId, unitIds),
    ...(first(search.leadAuditorId) === 'me' ? { leadAuditorId: 'me' as const } : {}),
    fy: listParam(search.fy).filter((v) => FY.test(v)),
    ...(system && systemIds.includes(system) ? { managementSystemId: system } : {}),
    ...(q ? { q } : {}),
    ids: listParam(search.ids),
  };
}

/**
 * The API query, or null when the filters can match nothing: FYs with no programme. The FYs become the ids of their
 * programmes, of the filtered system when there is one.
 */
export function auditsQuery(
  f: AuditFilters,
  programmes: readonly Pick<AuditProgrammeView, 'id' | 'fy' | 'managementSystemId'>[],
): Record<string, string> | null {
  const query: Record<string, string> = {};
  if (f.fy.length) {
    const ids = programmes
      .filter(
        (p) =>
          f.fy.includes(p.fy) &&
          (!f.managementSystemId || p.managementSystemId === f.managementSystemId),
      )
      .map((p) => p.id);
    if (ids.length === 0) return null;
    query.programmeId = ids.join(',');
  }
  if (f.state.length) query.state = f.state.join(',');
  if (f.unitId.length) query.unitId = f.unitId.join(',');
  if (f.leadAuditorId) query.leadAuditorId = f.leadAuditorId;
  if (f.managementSystemId) query.managementSystemId = f.managementSystemId;
  if (f.q) query.q = f.q;
  if (f.ids.length) query.ids = f.ids.join(',');
  return query;
}

export function auditFilterDefs(
  units: readonly Pick<Unit, 'id' | 'name'>[],
  fys: readonly string[],
): FilterDef[] {
  return [
    {
      key: 'state',
      label: 'State',
      kind: 'multi',
      order: 'given',
      options: InternalAuditState.options.map((s) => ({
        value: s,
        label: WORDS.InternalAuditState[s],
      })),
    },
    {
      key: 'fy',
      label: 'FY',
      kind: 'multi',
      order: 'given',
      options: fys.map((fy) => ({ value: fy, label: `FY ${fy}` })),
    },
    {
      key: 'unitId',
      label: 'Unit',
      kind: 'multi',
      options: units.map((u) => ({ value: u.id, label: u.name })),
    },
    {
      key: 'leadAuditorId',
      label: 'Lead auditor',
      kind: 'multi',
      options: [{ value: 'me', label: 'Me' }],
    },
  ];
}

export function auditFilterValue(f: AuditFilters): Record<string, string[]> {
  return {
    state: f.state,
    fy: f.fy,
    unitId: f.unitId,
    leadAuditorId: f.leadAuditorId ? [f.leadAuditorId] : [],
  };
}

/** The FYs with a programme, newest first, and the current one even without. */
export function programmeFys(
  programmes: readonly Pick<AuditProgrammeView, 'fy'>[],
  current: string,
): string[] {
  return [...new Set([current, ...programmes.map((p) => p.fy)])].sort().reverse();
}

export type AuditRow = {
  id: string;
  title: string;
  /** "FY 2024-25 · Pune Plant" */
  sub: string;
  audit: InternalAuditView;
  leadName: string;
};

/** The units an audit names, or its system's when it names none (unit scope, model §3.7). */
export function auditUnits(
  audit: Pick<InternalAuditView, 'unitIds'>,
  units: readonly Pick<Unit, 'id' | 'name'>[],
): string {
  if (audit.unitIds.length === 0) return 'All units of the system';
  return audit.unitIds
    .map((id) => units.find((u) => u.id === id)?.name ?? 'Unknown unit')
    .join(', ');
}

export function auditRows(
  audits: readonly InternalAuditView[],
  programmes: readonly Pick<AuditProgrammeView, 'id' | 'fy'>[],
  units: readonly Pick<Unit, 'id' | 'name'>[],
  people: readonly PersonOption[],
): AuditRow[] {
  return audits.map((a) => {
    const fy = programmes.find((p) => p.id === a.programmeId)?.fy;
    return {
      id: a.id,
      title: a.title,
      sub: [fy ? `FY ${fy}` : null, auditUnits(a, units)].filter(Boolean).join(' · '),
      audit: a,
      leadName: nameOf(people, a.leadAuditorId),
    };
  });
}

/** The people on an audit who also audit their own work, by name (9.2.2); empty when there are none. */
export function selfAuditorNames(
  audit: Parameters<typeof selfAuditors>[0],
  people: readonly PersonOption[],
): string {
  const ids = selfAuditors(audit);
  return ids.length ? namesOf(people, ids) : '';
}

/** An audit's programme choices: each system's programmes, newest FY first, named "Quality system, FY 2024-25". */
export function programmeOptions(
  programmes: readonly Pick<AuditProgrammeView, 'id' | 'fy' | 'managementSystemId'>[],
  systems: readonly Pick<ManagementSystem, 'id' | 'name'>[],
): { id: string; label: string; managementSystemId: string }[] {
  return [...programmes]
    .sort((a, b) => b.fy.localeCompare(a.fy))
    .map((p) => {
      const system = systems.find((s) => s.id === p.managementSystemId);
      return {
        id: p.id,
        managementSystemId: p.managementSystemId,
        label: systems.length > 1 && system ? `${system.name}, FY ${p.fy}` : `FY ${p.fy}`,
      };
    });
}

/** The audit's clauses that have no answered checklist row: REPORT needs a result for each (model §4.3). */
export function clausesWithoutResult(
  audit: Pick<InternalAuditView, 'clauseIds'>,
  rows: readonly { clauseId: string; result: string | null }[],
): string[] {
  return audit.clauseIds.filter((id) => !rows.some((r) => r.clauseId === id && r.result !== null));
}
