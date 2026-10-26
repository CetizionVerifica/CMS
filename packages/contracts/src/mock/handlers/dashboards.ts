// M10 endpoints: portfolio, client overview, breakdowns, calendar, reports and exports. Every number comes with
// the instance ids behind it, computed by the mock's copy of the engine rules (derive.ts). Statutory numbers count
// STATUTE-act instances only, with the ISO add-on on or off; the calendar takes `source` (docs/iso/plan.md §4.6).
import { RegisterQuery } from '../../api/workflow.js';
import {
  type ActivitySource,
  type BreakdownBy,
  type ExportKind,
  ISO_EXPORT_KINDS,
} from '../../enums.js';
import {
  type Actor,
  asOfFor,
  audit,
  fileUrl,
  fresh,
  fyRange,
  hasIso,
  instanceRow,
  isoNotEnabled,
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
import { actorOf, type HandlerContext, type PartialHandlers } from '../handler.js';
import type { InstanceRecord } from '../store.js';
import { SIGNED_URL_TTL_SECONDS } from '../../api/common.js';

interface Period {
  fy?: string;
  from?: string;
  to?: string;
  unitId?: string[];
}

/**
 * Instances of a client in the dashboard period (by due date) and units, of `source`: `LAW` for statutory numbers,
 * which never count ISO activities (plan §4.6), or the calendar's `source` query (both when absent and the add-on is
 * on; STATUTE only while it is off).
 */
function inPeriod(
  actor: Actor,
  clientId: string,
  period: Period,
  source: ActivitySource | undefined,
): InstanceRecord[] {
  const client = actor.firm.data.clients.find((c) => c.id === clientId)!;
  const range = period.fy === undefined ? null : fyRange(period.fy, client.settings.fyStartMonth);
  const from = range?.from ?? period.from;
  const to = range?.to ?? period.to;
  return visibleInstances(actor, clientId, source).filter(
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
  CLIENT_ARCHIVE_ZIP: 'zip',
  ISO_NC_LOG_XLSX: 'xlsx',
  ISO_RISK_REGISTER_XLSX: 'xlsx',
  ISO_AUDIT_REPORT_PDF: 'pdf',
  ISO_REVIEW_PACK_PDF: 'pdf',
} satisfies Record<ExportKind, string>;

const isIsoKind = (kind: ExportKind) => (ISO_EXPORT_KINDS as readonly string[]).includes(kind);

/**
 * The ISO export kinds are ISO data: creating one, reading its job or its download URL answers 403
 * FEATURE_NOT_ENABLED while the add-on is off (plan §4.4-4.5).
 */
function checkKindOn(actor: Actor, kind: ExportKind): void {
  if (isIsoKind(kind) && !hasIso(actor)) throw isoNotEnabled();
}

/** The export `id` names, after the role check and then the ISO off switch. */
function openExport(
  ctx: HandlerContext<'getExport' | 'exportDownloadUrl'>,
  id: string | undefined,
) {
  const actor = actorOf(ctx);
  const job = actor.firm.exports.find((e) => e.id === id);
  if (job === undefined) throw notFound();
  ctx.authorize({ clientId: job.clientId });
  checkKindOn(actor, job.kind);
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
        const instances = inPeriod(actor, clientId, ctx.query, 'LAW');
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
          // With the add-on on, the register also lists ISO activities, so the link says Law (plan §4.6).
          dueThisWeekFilter: {
            dueFrom: asOf,
            dueTo: addDays(asOf, 6),
            workflowState: ['OPEN' as const, 'SENT_BACK' as const],
            ...(hasIso(actor) ? { source: 'LAW' as const } : {}),
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
    // The overview is statutory: its lists, like its numbers, leave ISO activities out (ISO-11b).
    const instances = inPeriod(actor, clientId, ctx.query, 'LAW');
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
      inPeriod(actor, clientId, ctx.query, 'LAW'),
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
    const rows = rowsByDue(look, inPeriod(actor, clientId, ctx.query, ctx.query.source), asOf);
    const days = new Map<string, typeof rows>();
    for (const row of rows) days.set(row.dueDate, [...(days.get(row.dueDate) ?? []), row]);
    return { items: [...days].map(([date, items]) => ({ date, items })) };
  },

  actReport(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const asOf = asOfFor(actor, clientId, ctx.query.asOf, ctx.clock);
    return breakdown(
      new Lookup(actor.firm),
      inPeriod(actor, clientId, ctx.query, 'LAW'),
      'act',
      asOf,
    );
  },

  departmentReport(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    const asOf = asOfFor(actor, clientId, ctx.query.asOf, ctx.clock);
    return breakdown(
      new Lookup(actor.firm),
      inPeriod(actor, clientId, ctx.query, 'LAW'),
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
    const instances = inPeriod(actor, clientId, ctx.query, 'LAW');
    return {
      result: scoreResult(look, instances, asOf),
      items: rowsByDue(look, instances, asOf).filter((r) => r.status === 'OVERDUE'),
    };
  },

  createExport(ctx) {
    const actor = actorOf(ctx);
    const clientId = ctx.params.clientId!;
    ctx.authorize({ clientId });
    // The account export is for account admins only (endpoints.md §6).
    if (
      ctx.body.kind === 'CLIENT_ARCHIVE_ZIP' &&
      !actor.memberships.some((m) => m.role === 'FIRM_ADMIN')
    ) {
      throw new MockError('FORBIDDEN', 'Not allowed: export.create', { action: 'export.create' });
    }
    checkKindOn(actor, ctx.body.kind);
    // A register export follows the register, `source` and the ISO off switch included (plan §4.5); the body schema
    // checked an ISO kind's filters against its ISO list's query. The mock writes no file, so filters are only checked
    // and kept.
    const parsed = isIsoKind(ctx.body.kind)
      ? null
      : RegisterQuery.safeParse(Object.fromEntries(new URLSearchParams(ctx.body.filters)));
    if (parsed?.success === false) {
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
    return openExport(ctx, ctx.params.id);
  },

  exportDownloadUrl(ctx) {
    const job = openExport(ctx, ctx.params.id);
    return { url: fileUrl(`exports/${job.id}`), expiresAt: expiresAt(ctx.clock.now()) };
  },
};
