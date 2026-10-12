import type {
  ClientSettings,
  GeneratedPeriod,
  Id,
  LocalDate,
  RecurrenceRule,
} from '@canopy/contracts';
import { compareDates, ENGINE_VERSION, generateInstances } from '@canopy/engine';
import { clientDay, currentAndNextFy } from './client-day.js';
import type {
  FirmTx,
  GenerationTarget,
  JobAuditEvent,
  JobDeps,
  JobDomainEvent,
  JobReport,
  NewInstance,
} from './ports.js';

export const GENERATE_INSTANCES = 'generate-instances';

/**
 * Memoises engine generation per (rule, calendar, range). Many assignments share one obligation, and a client's
 * range is the same for all of them, so one engine call serves every unit the obligation is assigned to.
 */
export function memoisedGenerator(): (
  rule: RecurrenceRule,
  range: { from: LocalDate; to: LocalDate },
  settings: ClientSettings,
) => GeneratedPeriod[] {
  const cache = new Map<string, GeneratedPeriod[]>();
  return (rule, range, settings) => {
    const cal = { fyStartMonth: settings.fyStartMonth, holidayPolicy: settings.holidayPolicy };
    const key = JSON.stringify([rule, range, cal]);
    let periods = cache.get(key);
    if (!periods) {
      periods = generateInstances(rule, range, cal);
      cache.set(key, periods);
    }
    return periods;
  };
}

/**
 * Whether the job generates instances for an assignment, and why not. Event-driven obligations get an instance
 * when their event is recorded (M7), and a TO_REVIEW rule is a low-confidence import guess that a consultant has
 * not confirmed, so neither is generated ahead (ADR 0003).
 */
export function skipReason(
  t: GenerationTarget,
): 'NOT_APPLICABLE' | 'EVENT_DRIVEN' | 'RULE_TO_REVIEW' | null {
  if (t.applicability !== 'APPLICABLE') return 'NOT_APPLICABLE';
  if (t.recurrenceRule.kind === 'EVENT_DRIVEN') return 'EVENT_DRIVEN';
  if (t.ruleStatus !== 'CONFIRMED') return 'RULE_TO_REVIEW';
  return null;
}

/** The FY range narrowed to the assignment's active window, or null when they do not overlap. */
function activeRange(
  t: GenerationTarget,
  fy: { from: LocalDate; to: LocalDate },
): { from: LocalDate; to: LocalDate } | null {
  const from = compareDates(t.activeFrom, fy.from) > 0 ? t.activeFrom : fy.from;
  const to = t.activeTo !== null && compareDates(t.activeTo, fy.to) < 0 ? t.activeTo : fy.to;
  return compareDates(from, to) <= 0 ? { from, to } : null;
}

async function generateForClient(
  tx: FirmTx,
  client: { id: Id; settings: ClientSettings },
  deps: JobDeps,
  requestId: string,
  generate: ReturnType<typeof memoisedGenerator>,
  report: JobReport,
): Promise<void> {
  const now = deps.clock();
  const fy = currentAndNextFy(
    clientDay(now, client.settings.timeZone).today,
    client.settings.fyStartMonth,
  );
  const targets = await tx.listGenerationTargets(client.id);
  const live = targets.filter((t) => {
    const reason = skipReason(t);
    if (reason) report[`skipped${reason}`] = (report[`skipped${reason}`] ?? 0) + 1;
    return reason === null;
  });
  if (live.length === 0) return;
  // Imported instances keep the register's own period starts, so a period whose due date already has an
  // instance is the same occurrence even if its start differs: skip it rather than create a twin.
  const existing = await tx.listInstanceKeys(
    live.map((t) => t.assignmentId),
    fy,
  );
  const seen = new Set(
    existing.flatMap((k) => [
      `${k.assignmentId}|p${k.periodStart}`,
      `${k.assignmentId}|d${k.dueDate}`,
    ]),
  );

  const rows: NewInstance[] = [];
  for (const t of live) {
    const range = activeRange(t, fy);
    if (!range) continue;
    for (const p of generate(t.recurrenceRule, range, client.settings)) {
      if (
        seen.has(`${t.assignmentId}|p${p.periodStart}`) ||
        seen.has(`${t.assignmentId}|d${p.dueDate}`)
      )
        continue;
      rows.push({
        assignmentId: t.assignmentId,
        clientId: client.id,
        ...p,
        ownerId: t.ownerId,
        approverId: t.approverId,
      });
    }
  }
  if (rows.length === 0) return;
  const ids = await tx.insertInstances(rows);

  const audits: JobAuditEvent[] = [];
  // One `instance.generated` per created instance (docs/contracts/events.md §3, contracts 1.2.0).
  const events: JobDomainEvent[] = [];
  rows.forEach((row, index) => {
    const id = ids[index];
    if (!id) return;
    audits.push({
      clientId: client.id,
      at: now,
      requestId,
      actorId: null,
      actorKind: 'SYSTEM',
      action: 'CREATE',
      entityType: 'instance',
      entityId: id,
      before: null,
      after: {
        assignmentId: row.assignmentId,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        dueDate: row.dueDate,
        workflowState: 'OPEN',
        ownerId: row.ownerId,
        approverId: row.approverId,
        engineVersion: ENGINE_VERSION,
      },
      reason: null,
    });
    events.push({
      type: 'instance.generated',
      clientId: client.id,
      actor: { kind: 'SYSTEM', job: GENERATE_INSTANCES },
      requestId,
      aggregate: { type: 'instance', id },
      aggregateVersion: 1,
      data: {
        instanceId: id,
        assignmentId: row.assignmentId,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        dueDate: row.dueDate,
        engineVersion: ENGINE_VERSION,
      },
    });
  });
  await tx.writeAudit(audits);
  await tx.writeEvents(events);
  report.created = (report.created ?? 0) + audits.length;
  report.existing = (report.existing ?? 0) + rows.length - audits.length;
}

/**
 * Nightly: makes sure every applicable assignment has its instances for the current and next FY. Idempotent: the
 * key is `(assignment_id, period_start)`, so a re-run, an overlapping run or a run after an import creates
 * nothing new. Each client is one transaction, so a failure in one client does not undo the others; the job
 * still fails afterwards so pg-boss retries it.
 */
export async function runGenerateInstances(deps: JobDeps, requestId: string): Promise<JobReport> {
  const report: JobReport = { firms: 0, clients: 0, created: 0, existing: 0 };
  const generate = memoisedGenerator();
  const failures: unknown[] = [];
  for (const firmId of await deps.store.listFirmIds()) {
    report.firms! += 1;
    const clients = await deps.store.withFirm(firmId, requestId, (tx) => tx.listClients());
    for (const client of clients) {
      report.clients! += 1;
      try {
        await deps.store.withFirm(firmId, requestId, (tx) =>
          generateForClient(tx, client, deps, requestId, generate, report),
        );
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${GENERATE_INSTANCES}: ${failures.length} client(s) failed`,
    );
  }
  return report;
}
