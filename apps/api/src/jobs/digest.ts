import { DEFAULT_CLIENT_SETTINGS, type Id } from '@canopy/contracts';
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
import { servedFirmIds } from './accounts.js';

export const CONSULTANT_DIGEST = 'consultant-digest';

/** The digest's score and counts are statutory numbers: STATUTE acts only, with the ISO add-on on or off (plan §4.6). */
const STATUTE_ONLY = { actKinds: ['STATUTE'] } as const;

export function clientUrl(appUrl: string, clientId: Id): string {
  return new URL(`/c/${clientId}/overview`, appUrl).toString();
}

/**
 * The time zone that fixes a consultant's digest day. A consultant gets at most one digest per date (the send
 * log's digest key is recipient, kind and date), so every client must agree on which date that is, even when
 * clients sit in different zones. It is the product default, India time (ADR M9-0001 §8).
 */
export const DIGEST_TIME_ZONE = DEFAULT_CLIENT_SETTINGS.timeZone;

/**
 * Runs every 15 minutes. On each India-time date, a consultant's digest covers every client of theirs whose digest
 * weekday is that date, and goes out once India time passes the earliest send time among those clients. Each
 * client's scores and counts come from the engine at the client's own local date, over its current FY to date.
 */
export async function runConsultantDigest(deps: JobDeps, requestId: string): Promise<JobReport> {
  const report: JobReport = { firms: 0, consultants: 0, sent: 0 };
  const failures: unknown[] = [];
  const now = deps.clock();
  const anchor = clientDay(now, DIGEST_TIME_ZONE);
  const digestDate = anchor.today;
  for (const firmId of await servedFirmIds(deps, requestId)) {
    report.firms! += 1;
    const { clients, consultants, firmSettings, done } = await deps.store.withFirm(
      firmId,
      requestId,
      async (tx) => ({
        clients: await tx.listClients(),
        consultants: await tx.listConsultants(),
        firmSettings: await tx.firmSettings(),
        // Skips the score queries for digests already sent today; the claim in deliver() is the real guard.
        done: new Set(await tx.listDoneDigests(digestDate)),
      }),
    );
    const clientsById = new Map(clients.map((c) => [c.id, c]));

    for (const consultant of consultants) {
      report.consultants! += 1;
      const due = consultant.clientIds
        .map((id) => clientsById.get(id))
        .filter((c): c is ClientRef => c !== undefined)
        .filter((c) => isConsultantDigestDay(digestDate, c.settings.reminders))
        .sort((a, b) => a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id));
      if (due.length === 0) continue;
      const earliest = due.reduce((min, c) =>
        c.settings.reminders.sendAtLocalTime < min.settings.reminders.sendAtLocalTime ? c : min,
      );
      if (!sendTimeReached(anchor, earliest.settings)) continue;
      if (done.has(consultant.personId)) {
        report.alreadySent = (report.alreadySent ?? 0) + 1;
        continue;
      }
      try {
        const summaries: DigestClientSummary[] = [];
        let label = '';
        for (const client of due) {
          const asOf = clientDay(now, client.settings.timeZone).today;
          const fy = fyBounds(
            fyStartYear(asOf, client.settings.fyStartMonth),
            client.settings.fyStartMonth,
          );
          label ||= fyLabel(asOf, client.settings.fyStartMonth);
          const items = await deps.store.withFirm(firmId, requestId, (tx) =>
            tx.listScoreItems(client.id, fy, STATUTE_ONLY),
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
            clientId: due[0]!.id,
            instanceId: null,
            recipientId: consultant.personId,
            kind: 'CONSULTANT_DIGEST',
            sendDate: digestDate,
          },
          {
            name: consultant.displayName,
            email: consultant.email,
            canReceive: consultant.canReceive,
          },
          {
            kind: 'CONSULTANT_DIGEST',
            recipientName: consultant.displayName,
            asOf: digestDate,
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
  if (failures.length > 0) {
    throw new AggregateError(failures, `${CONSULTANT_DIGEST}: ${failures.length} digest(s) failed`);
  }
  return report;
}
