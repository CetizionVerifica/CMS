// Certificates and certification body visits in words (packages.md ISO-6a, model §3.9). A certificate being pursued
// has no number or dates yet; an issued one has its surveillance and recertification dates from the API's
// `certificationCycle`. Nothing here works a date out: every due date and day count is the API's.
import type {
  CertificationCycleItem,
  CertificationView,
  ExternalAuditView,
  IsoStandard,
} from '@canopy/contracts';
import { formatDate } from '@canopy/ui';

import { standardTitle, word } from '../_lib/words';

export type CycleLine = { label: string; text: string; tone: 'neutral' | 'ok' | 'warn' | 'crit' };

/** One due date of a certificate's cycle: "Surveillance 1, due 12 Mar 2025: met 10 Mar 2025". */
export function cycleLine(item: CertificationCycleItem): CycleLine {
  const label = `${word('CertificationCycleKind', item.kind)}, due ${formatDate(item.dueOn)}`;
  if (item.metOn !== null) {
    return item.daysLate === null
      ? { label, text: `Met ${formatDate(item.metOn)}`, tone: 'ok' }
      : {
          label,
          text: `Met ${formatDate(item.metOn)}, ${item.daysLate} ${item.daysLate === 1 ? 'day' : 'days'} late`,
          tone: 'warn',
        };
  }
  if (item.overdueDays !== null) {
    return {
      label,
      text: `Overdue ${item.overdueDays} ${item.overdueDays === 1 ? 'day' : 'days'}`,
      tone: 'crit',
    };
  }
  return { label, text: 'Not yet held', tone: 'neutral' };
}

export function isIssued(c: Pick<CertificationView, 'issuedOn'>): boolean {
  return c.issuedOn !== null;
}

/** "Stage 1 · ISO 9001, ISO 14001". */
export function auditTitle(
  audit: Pick<ExternalAuditView, 'type' | 'standardIds'>,
  standards: readonly IsoStandard[],
): string {
  return `${word('ExternalAuditType', audit.type)} · ${audit.standardIds
    .map((id) => standardTitle(standards, id))
    .join(', ')}`;
}

/** "3 to 5 Mar 2025", or one date for a one-day visit. */
export function auditDates(a: Pick<ExternalAuditView, 'startOn' | 'endOn'>): string {
  return a.startOn === a.endOn
    ? formatDate(a.startOn)
    : `${formatDate(a.startOn)} to ${formatDate(a.endOn)}`;
}

/** Certificates to show: the `ids` an overview number counted, or all, by standard order then body. */
export function certificatesToShow(
  certs: readonly CertificationView[],
  ids: readonly string[],
  standardOrder: readonly string[],
): CertificationView[] {
  return certs
    .filter((c) => ids.length === 0 || ids.includes(c.id))
    .sort(
      (a, b) =>
        standardOrder.indexOf(a.standardId) - standardOrder.indexOf(b.standardId) ||
        a.body.localeCompare(b.body),
    );
}

/** Newest visit first. */
export function auditsByDate(audits: readonly ExternalAuditView[]): ExternalAuditView[] {
  return [...audits].sort((a, b) => b.startOn.localeCompare(a.startOn));
}

/** Whether the visit can still change (CLOSED and CANCELLED are final). */
export function auditOpen(a: Pick<ExternalAuditView, 'state'>): boolean {
  return a.state !== 'CLOSED' && a.state !== 'CANCELLED';
}
