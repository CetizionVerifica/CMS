import { z } from 'zod';
import {
  ActivitySource,
  BreakdownBy,
  ExportKind,
  ISO_EXPORT_KINDS,
  type IsoExportKind,
} from '../enums.js';
import { FyLabel, Id, LocalDate } from '../primitives.js';
import { InstanceRow } from '../schemas/work.js';
import { ScoreResult } from '../schemas/scores.js';
import { asOfQueryShape, checkPeriod, csv } from './common.js';
import { ISO_EXPORT_FILTERS } from './iso.js';
import { RegisterFilterQuery } from './workflow.js';

/**
 * M10 · Dashboards, calendar, reports and exports (docs/contracts/endpoints.md §6).
 * Every number is a ScoreResult carrying the instance ids behind it.
 */

/** `fy` or `from`/`to`, `unitId`, and `asOf` (FIRM_ADMIN, CONSULTANT and VIEWER only). */
export const dashboardQueryShape = {
  ...asOfQueryShape,
  fy: FyLabel.optional(),
  from: LocalDate.optional(),
  to: LocalDate.optional(),
  unitId: csv(Id).optional(),
};

function checkDashboardPeriod(
  query: { fy?: unknown; from?: string; to?: string },
  ctx: z.core.$RefinementCtx,
): void {
  checkPeriod(query, ctx, { from: 'from', to: 'to' });
  if (query.from !== undefined && query.to !== undefined && query.to < query.from) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'to is before from' });
  }
}

export const DashboardQuery = z.strictObject(dashboardQueryShape).superRefine(checkDashboardPeriod);

export const BreakdownQuery = z
  .strictObject({ ...dashboardQueryShape, by: BreakdownBy })
  .superRefine(checkDashboardPeriod);

/** A calendar month or week view; the provider may cap the range length. */
export const CalendarQuery = z
  .strictObject({
    ...asOfQueryShape,
    from: LocalDate,
    to: LocalDate,
    unitId: csv(Id).optional(),
    source: ActivitySource.optional(),
  })
  .refine((query) => query.to >= query.from, { path: ['to'], message: 'to is before from' });

export const ClientOverview = z.strictObject({
  result: ScoreResult,
  /** Next items due in the period, by due date. */
  upcoming: z.array(InstanceRow),
  /** The signed-in person's open items; empty for roles without tasks. */
  myTasks: z.array(InstanceRow),
});
export type ClientOverview = z.infer<typeof ClientOverview>;

export const CalendarDay = z.strictObject({ date: LocalDate, items: z.array(InstanceRow) });
export type CalendarDay = z.infer<typeof CalendarDay>;

export const REPORT_KINDS = ['act-wise', 'department-wise', 'overdue'] as const;

/** The query an export's `filters` must parse as: the register's, or an ISO list's for the ISO kinds. */
function exportFilterQuery(kind: string): z.ZodType {
  return (ISO_EXPORT_KINDS as readonly string[]).includes(kind)
    ? ISO_EXPORT_FILTERS[kind as IsoExportKind]
    : RegisterFilterQuery;
}

/**
 * `POST /clients/{clientId}/exports`. `filters` is a query string without the leading "?", so an export matches the
 * view it was started from: the register's (api-conventions.md §3), or for the ISO kinds (staged, `ISO_EXPORT_KINDS`)
 * the ISO list's in `ISO_EXPORT_FILTERS`.
 */
export const ExportCreateBody = z
  .strictObject({
    kind: ExportKind,
    filters: z.string().max(4000).default(''),
    unitId: Id.optional(),
    fy: FyLabel.optional(),
  })
  .superRefine((body, ctx) => {
    const parsed = exportFilterQuery(body.kind).safeParse(
      Object.fromEntries(new URLSearchParams(body.filters)),
    );
    for (const issue of parsed.error?.issues ?? []) {
      ctx.addIssue({ code: 'custom', path: ['filters', ...issue.path], message: issue.message });
    }
  })
  .superRefine((body, ctx) => {
    // The account export is the client's whole register, so it takes no scope (endpoints.md §6).
    if (body.kind !== 'CLIENT_ARCHIVE_ZIP') return;
    if (body.filters !== '') {
      ctx.addIssue({
        code: 'custom',
        path: ['filters'],
        message: 'A client archive takes no filters',
      });
    }
    for (const key of ['unitId', 'fy'] as const) {
      if (body[key] !== undefined) {
        ctx.addIssue({ code: 'custom', path: [key], message: `A client archive takes no ${key}` });
      }
    }
  });
export type ExportCreateBody = z.input<typeof ExportCreateBody>;
