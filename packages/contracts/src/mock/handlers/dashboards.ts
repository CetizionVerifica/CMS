// M10 endpoints: portfolio, client overview, breakdowns, calendar, reports and exports. Every number comes with
// the instance ids behind it, computed by the mock's copy of the engine rules (derive.ts).
import { RegisterQuery } from '../../api/workflow.js';
import type { BreakdownBy } from '../../enums.js';
import {
  type Actor,
  asOfFor,
  audit,
  fileUrl,
  fresh,
  fyRange,
  instanceRow,
  Lookup,
  MockError,
  notFound,
  scoreResult,
  sortRows,
  visibleClientIds,
  visibleInstances,
} from '../core.js';
import { daysBetween } from '../derive.js';
import { addDays } from '../periods.js';
import { actorOf, type PartialHandlers } from '../handler.js';
import type { InstanceRecord } from '../store.js';
import { SIGNED_URL_TTL_SECONDS } from '../../api/common.js';

interface Period {
  fy?: string;
  from?: string;
  to?: string;
  unitId?: string[];
}

/** Instances of a client in the dashboard period (by due date) and units. */
function inPeriod(actor: Actor, clientId: string, period: Period): InstanceRecord[] {
  const client = actor.firm.data.clients.find((c) => c.id === clientId)!;
  const range = period.fy === undefined ? null : fyRange(period.fy, client.settings.fyStartMonth);
  const from = range?.from ?? period.from;
  const to = range?.to ?? period.to;
  return visibleInstances(actor, clientId).filter(
    (i) =>
      (from === undefined || i.dueDate >= from) &&
      (to === undefined || i.dueDate <= to) &&
      (period.unitId === undefined || period.unitId.includes(i.unitId)),
  );
}

const OPEN = ['OPEN', 'SENT_BACK'];

function breakdown(look: Lookup, instances: InstanceRecord[], by: BreakdownBy, asOf: string) {
  const keyOf = (i: InstanceRecord): [string, string] => {
    const assignment = look.assignments.get(i.assignmentId)!;
    const obligation = look.obligations.get(assignment.obligationId)!;
    switch (by) {
      case 'department':
        return [assignment.departmentId, look.departments.get(assignment.departmentId)!.name];
      case 'act':
        return [obligation.actId, look.acts.get(obligation.actId)!.name];
      case 'criticality':
        return [obligation.criticality, obligation.criticality];
      case 'unit':
        return [i.unitId, look.units.get(i.unitId)!.name];
      case 'owner':
        return [i.ownerId, look.people.get(i.ownerId)!.displayName];
    }
  };
  const groups = new Map<string, { label: string; items: InstanceRecord[] }>();
  for (const i of instances) {
    const [key, label] = keyOf(i);
    const group = groups.get(key) ?? { label, items: [] };
    group.items.push(i);
    groups.set(key, group);
  }
  return {
    by,
    rows: [...groups]
      .map(([key, { label, items }]) => ({ key, label, result: scoreResult(look, items, asOf) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

const rowsByDue = (look: Lookup, items: InstanceRecord[], asOf: string) =>
  sortRows(
    items.map((i) => instanceRow(look, i, asOf)),
    [{ field: 'dueDate', direction: 'asc' }],
  );

const expiresAt = (now: string) =>
  new Date(Date.parse(now) + SIGNED_URL_TTL_SECONDS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const EXPORT_EXTENSION = {
  REGISTER_XLSX: 'xlsx',
  CERTIFICATE_PDF: 'pdf',
  ACT_REPORT_XLSX: 'xlsx',
  DEPARTMENT_REPORT_XLSX: 'xlsx',
  OVERDUE_REPORT_XLSX: 'xlsx',
};

function findExport(actor: Actor, id: string | undefined) {
  const job = actor.firm.exports.find((e) => e.id === id);
  if (job === undefined) throw notFound();
  return job;
}

export const dashboardHandlers: PartialHandlers<
  | 'portfolio'
  | 'clientOverview'
  | 'breakdown'
  | 'calendar'
  | 'actReport'
  | 'departmentReport'
  | 'overdueReport'
  | 'createExport'
  | 'getExport'
  | 'exportDownloadUrl'
> = {
  portfolio(ctx) {
    const actor = actorOf(ctx);
    ctx.authorize({ clientId: null });
    const asOf = asOfFor(actor, null, ctx.query.asOf, ctx.clock);
    const look = new Lookup(actor.firm);
    return {
      items: visibleClientIds(actor).map((clientId) => {
        const instances = inPeriod(actor, clientId, ctx.query);
        const updated = instances.map((i) => i.updatedAt).sort();
        return {
          clientId,
          clientName: look.clients.get(clientId)!.name,
          result: scoreResult(look, instances, asOf),
          dueThisWeek: instances.filter(
            (i) =>
              OPEN.includes(i.workflowState) &&
              i.dueDate >= asOf &&
              daysBetween(asOf, i.dueDate) < 7,
          ).length,
          dueThisWeekFilter: {
            dueFrom: asOf,
            dueTo: addDays(asOf, 6),
            workflowState: ['OPEN' as const, 'SENT_BACK' as const],
          },
          lastActivityAt: updated.at(-1) ?? null,
        };
      }),
    };
  },

  clientOverview(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const asOf = asOfFor(actor, clientId, ctx.query.asOf, ctx.clock);
    const look = new Lookup(actor.firm);
    const instances = inPeriod(actor, clientId, ctx.query);
    const pending = instances.filter((i) => [...OPEN, 'SUBMITTED'].includes(i.workflowState));
    return {
      result: scoreResult(look, instances, asOf),
      upcoming: rowsByDue(
        look,
        pending.filter((i) => i.dueDate >= asOf),
        asOf,
      ).slice(0, 10),
      myTasks: rowsByDue(
        look,
        instances.filter((i) => OPEN.includes(i.workflowState) && i.ownerId === actor.person.id),
        asOf,
      ).slice(0, 10),
    };
  },

  breakdown(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const asOf = asOfFor(actor, clientId, ctx.query.asOf, ctx.clock);
    return breakdown(
      new Lookup(actor.firm),
      inPeriod(actor, clientId, ctx.query),
      ctx.query.by,
      asOf,
    );
  },

  calendar(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const asOf = asOfFor(actor, clientId, ctx.query.asOf, ctx.clock);
    const look = new Lookup(actor.firm);
    const rows = rowsByDue(look, inPeriod(actor, clientId, ctx.query), asOf);
    const days = new Map<string, typeof rows>();
    for (const row of rows) days.set(row.dueDate, [...(days.get(row.dueDate) ?? []), row]);
    return { items: [...days].map(([date, items]) => ({ date, items })) };
  },

  actReport(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const asOf = asOfFor(actor, clientId, ctx.query.asOf, ctx.clock);
    return breakdown(new Lookup(actor.firm), inPeriod(actor, clientId, ctx.query), 'act', asOf);
  },

  departmentReport(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const asOf = asOfFor(actor, clientId, ctx.query.asOf, ctx.clock);
    return breakdown(
      new Lookup(actor.firm),
      inPeriod(actor, clientId, ctx.query),
      'department',
      asOf,
    );
  },

  overdueReport(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const asOf = asOfFor(actor, clientId, ctx.query.asOf, ctx.clock);
    const look = new Lookup(actor.firm);
    const instances = inPeriod(actor, clientId, ctx.query);
    return {
      result: scoreResult(look, instances, asOf),
      items: rowsByDue(look, instances, asOf).filter((r) => r.status === 'OVERDUE'),
    };
  },

  createExport(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const filters = Object.fromEntries(new URLSearchParams(ctx.body.filters));
    const parsed = RegisterQuery.safeParse(filters);
    if (!parsed.success) {
      throw new MockError('VALIDATION', 'filters is not a valid register query', {
        issues: parsed.error.issues.map((issue) => ({
          path: ['filters', ...issue.path.map(String)],
          message: issue.message,
        })),
      });
    }
    const { id, firmId, createdAt, updatedAt, archivedAt } = fresh(ctx, actor.firm.data.firm.id);
    const job = {
      id,
      firmId,
      createdAt,
      updatedAt,
      archivedAt,
      clientId,
      kind: ctx.body.kind,
      params: {
        filters: ctx.body.filters,
        unitId: ctx.body.unitId ?? null,
        fy: ctx.body.fy ?? null,
      },
      status: 'DONE' as const,
      fileName: `${ctx.body.kind.toLowerCase().replaceAll('_', '-')}-${ctx.clock.today()}.${EXPORT_EXTENSION[ctx.body.kind]}`,
      requestedById: actor.person.id,
    };
    actor.firm.exports.push(job);
    audit(ctx, actor, {
      action: 'EXPORT',
      entityType: 'export',
      entityId: job.id,
      clientId,
      after: { kind: job.kind },
    });
    return job;
  },

  getExport(ctx) {
    const job = findExport(actorOf(ctx), ctx.params.id);
    ctx.authorize({ clientId: job.clientId });
    return job;
  },

  exportDownloadUrl(ctx) {
    const job = findExport(actorOf(ctx), ctx.params.id);
    ctx.authorize({ clientId: job.clientId });
    return { url: fileUrl(`exports/${job.id}`), expiresAt: expiresAt(ctx.clock.now()) };
  },
};
