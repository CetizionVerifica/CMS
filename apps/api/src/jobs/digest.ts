import type { Id, LocalDate } from '@canopy/contracts';
import {
  computeScore,
  fyBounds,
  fyLabel,
  fyStartYear,
  isConsultantDigestDay,
  summarizeKpis,
} from '@canopy/engine';
import type { DigestClientSummary } from '@canopy/notifications';
import { clientDay, sendTimeReached } from './client-day.js';
import type { ClientRef, JobDeps, JobReport } from './ports.js';
import { deliver } from './send.js';

export const CONSULTANT_DIGEST = 'consultant-digest';

export function clientUrl(appUrl: string, clientId: Id): string {
  return new URL(`/c/${clientId}/overview`, appUrl).toString();
}

/**
 * Runs every 15 minutes. A consultant gets at most one digest per day (the send log's digest key is recipient,
 * kind and date), so all their clients whose digest weekday is that day go into one email, sent once the
 * earliest of those clients' send times has passed. Scores and counts come from the engine over each client's
 * current FY to date.
 */
export async function runConsultantDigest(deps: JobDeps, requestId: string): Promise<JobReport> {
  const report: JobReport = { firms: 0, consultants: 0, sent: 0 };
  const failures: unknown[] = [];
  const now = deps.clock();
  for (const firmId of await deps.store.listFirmIds()) {
    report.firms! += 1;
    const { clients, consultants, firmSettings } = await deps.store.withFirm(
      firmId,
      requestId,
      async (tx) => ({
        clients: await tx.listClients(),
        consultants: await tx.listConsultants(),
        firmSettings: await tx.firmSettings(),
      }),
    );
    const clientsById = new Map(clients.map((c) => [c.id, c]));

    for (const consultant of consultants) {
      report.consultants! += 1;
      // Clients whose digest day it is, grouped by their local date (clients can sit in different time zones).
      const byDate = new Map<LocalDate, { clients: ClientRef[]; reached: boolean }>();
      for (const clientId of consultant.clientIds) {
        const client = clientsById.get(clientId);
        if (!client) continue;
        const day = clientDay(now, client.settings.timeZone);
        if (!isConsultantDigestDay(day.today, client.settings.reminders)) continue;
        const group = byDate.get(day.today) ?? { clients: [], reached: false };
        group.clients.push(client);
        group.reached ||= sendTimeReached(day, client.settings);
        byDate.set(day.today, group);
      }
      for (const [asOf, group] of byDate) {
        if (!group.reached) continue;
        const sorted = [...group.clients].sort((a, b) => a.name.localeCompare(b.name, 'en'));
        try {
          // Skip the score queries when today's digest already went out; the claim below is the real guard.
          const done = await deps.store.withFirm(firmId, requestId, (tx) =>
            tx.listDoneSends(sorted[0]!.id, asOf),
          );
          if (
            done.some(
              (k) => k.kind === 'CONSULTANT_DIGEST' && k.recipientId === consultant.personId,
            )
          ) {
            report.alreadySent = (report.alreadySent ?? 0) + 1;
            continue;
          }
          const summaries: DigestClientSummary[] = [];
          let label = '';
          for (const client of sorted) {
            const fy = fyBounds(
              fyStartYear(asOf, client.settings.fyStartMonth),
              client.settings.fyStartMonth,
            );
            label ||= fyLabel(asOf, client.settings.fyStartMonth);
            const items = await deps.store.withFirm(firmId, requestId, (tx) =>
              tx.listScoreItems(client.id, fy),
            );
            const result = computeScore(items, asOf, firmSettings);
            const kpis = summarizeKpis(result);
            summaries.push({
              clientName: client.name,
              score: result.score,
              overdue: kpis.overdue.count,
              dueSoon: kpis.dueSoon.count,
              awaitingApproval: kpis.awaitingApproval.count,
              url: clientUrl(deps.appUrl, client.id),
            });
          }
          await deliver(
            deps,
            firmId,
            requestId,
            {
              clientId: sorted[0]!.id,
              instanceId: null,
              recipientId: consultant.personId,
              kind: 'CONSULTANT_DIGEST',
              sendDate: asOf,
            },
            {
              name: consultant.displayName,
              email: consultant.email,
              canReceive: consultant.canReceive,
            },
            {
              kind: 'CONSULTANT_DIGEST',
              recipientName: consultant.displayName,
              asOf,
              fyLabel: label,
              clients: summaries,
            },
            CONSULTANT_DIGEST,
            report,
          );
        } catch (error) {
          failures.push(error);
        }
      }
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${CONSULTANT_DIGEST}: ${failures.length} digest(s) failed`);
  }
  return report;
}
