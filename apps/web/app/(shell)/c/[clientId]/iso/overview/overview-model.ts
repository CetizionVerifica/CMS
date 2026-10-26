// The ISO overview's numbers as rows of words and links. Every number comes from the API (M16's overview, the engine's
// results) with the ids behind it; this file only words them and builds the link to the list holding exactly those
// records. Where the list has a filter that matches the number exactly the link uses it; otherwise it names the ids.
import {
  RiskKind,
  type CertificationGate,
  type ClimateGap,
  type GateResult,
  type IdCount,
  type IsoReviewInputDef,
  type IsoSystemOverview,
} from '@canopy/contracts';

import { hrefWith } from '../_lib/people';
import { word } from '../_lib/words';

export type CountLink = {
  label: string;
  count: number;
  href: string;
  /** Said beside the number when its link cannot name exactly the records it counts. */
  note?: string;
};
export type CountGroup = { title: string; items: CountLink[] };

const ids = (c: IdCount) => c.ids.join(',');

/** The most ids a list's `ids` filter takes (contracts, ISO-1a4). */
export const MAX_LINK_IDS = 200;

/**
 * A count's link to the list holding exactly its records, by their ids. Past the `ids` filter's limit it opens the
 * system's whole list instead, and says so.
 */
function idsLink(
  href: (query: Record<string, string | undefined>) => string,
  systemId: string,
  c: IdCount,
): Pick<CountLink, 'href' | 'note'> {
  if (c.ids.length <= MAX_LINK_IDS) return { href: href({ ids: ids(c) }) };
  return {
    href: href({ managementSystemId: systemId }),
    note: "Too many to list on their own: the link shows all of the system's records.",
  };
}

/** The client's ISO pages. */
export function isoPath(clientId: string, page: string): string {
  return `/c/${clientId}/iso/${page}`;
}

/** The overview's counts, grouped as the page shows them. */
export function countGroups(clientId: string, s: IsoSystemOverview): CountGroup[] {
  const sys = s.managementSystemId;
  const at = (page: string, query: Record<string, string | undefined>) =>
    hrefWith(isoPath(clientId, page), query);
  return [
    {
      title: 'Nonconformities',
      items: [
        {
          label: 'Open',
          count: s.nonconformities.open.count,
          href: at('nonconformities', {
            managementSystemId: sys,
            state: 'OPEN,ROOT_CAUSE_FOUND,ACTIONS_PLANNED,AWAITING_VERIFICATION',
          }),
        },
        {
          label: 'Overdue',
          count: s.nonconformities.overdue.count,
          href: at('nonconformities', { managementSystemId: sys, overdue: 'true' }),
        },
        {
          label: 'Awaiting verification',
          count: s.nonconformities.awaitingVerification.count,
          href: at('nonconformities', { managementSystemId: sys, state: 'AWAITING_VERIFICATION' }),
        },
        {
          label: 'Effectiveness check overdue',
          count: s.nonconformities.effectivenessOverdue.count,
          ...idsLink((q) => at('nonconformities', q), sys, s.nonconformities.effectivenessOverdue),
        },
      ],
    },
    {
      title: 'Actions',
      items: [
        {
          label: 'Open',
          count: s.actions.open.count,
          href: at('actions', { managementSystemId: sys, state: 'OPEN' }),
        },
        {
          label: 'Overdue',
          count: s.actions.overdue.count,
          href: at('actions', { managementSystemId: sys, overdue: 'true' }),
        },
      ],
    },
    {
      title: 'Documents',
      items: [
        {
          label: 'Revision in review',
          count: s.documents.inReview.count,
          ...idsLink((q) => at('documents', q), sys, s.documents.inReview),
        },
        {
          label: 'Review overdue',
          count: s.documents.reviewOverdue.count,
          ...idsLink((q) => at('documents', q), sys, s.documents.reviewOverdue),
        },
      ],
    },
    {
      title: 'Risks',
      items: [
        {
          label: 'Significant',
          count: s.risks.significant.count,
          href: at('risks', { managementSystemId: sys, significant: 'true' }),
        },
        {
          label: 'Review overdue',
          count: s.risks.reviewOverdue.count,
          ...idsLink((q) => at('risks', q), sys, s.risks.reviewOverdue),
        },
      ],
    },
    {
      title: 'Objectives',
      items: [
        {
          label: 'Open',
          count: s.objectives.open.count,
          href: at('objectives', { managementSystemId: sys, open: 'true' }),
        },
        {
          label: 'Off track',
          count: s.objectives.offTrack.count,
          ...idsLink((q) => at('objectives', q), sys, s.objectives.offTrack),
        },
      ],
    },
    {
      title: 'Certificates',
      items: [
        {
          label: 'Expiring within 90 days',
          count: s.certificates.expiringSoon.count,
          href: at('certification', { ids: ids(s.certificates.expiringSoon) }),
        },
        {
          label: 'Surveillance or recertification overdue',
          count: s.certificates.cycleOverdue.count,
          href: at('certification', { ids: ids(s.certificates.cycleOverdue) }),
        },
      ],
    },
  ];
}

/** Readiness counts for one standard (or the whole system), each linking to its checklist rows in that system. */
export function readinessLinks(
  clientId: string,
  systemId: string,
  standardId: string | undefined,
  r: {
    implemented: string[];
    partial: string[];
    notStarted: string[];
    naPending: string[];
    excluded: string[];
  },
): CountLink[] {
  const at = (query: Record<string, string>) =>
    hrefWith(isoPath(clientId, 'checklist'), { system: systemId, standardId, ...query });
  return [
    { label: 'Implemented', count: r.implemented.length, href: at({ status: 'IMPLEMENTED' }) },
    { label: 'Partial', count: r.partial.length, href: at({ status: 'PARTIAL' }) },
    { label: 'Not started', count: r.notStarted.length, href: at({ status: 'NOT_STARTED' }) },
    {
      label: 'Not applicable requested',
      count: r.naPending.length,
      href: at({ naState: 'REQUESTED' }),
    },
    { label: 'Excluded', count: r.excluded.length, href: at({ naState: 'APPROVED' }) },
  ];
}

const GATE_PAGE: Record<CertificationGate, (sys: string) => [string, Record<string, string>]> = {
  INTERNAL_AUDIT: () => ['audits', {}],
  MANAGEMENT_REVIEW: () => ['management-reviews', {}],
  SCOPE: () => ['overview', {}],
  POLICY: (sys) => ['documents', { managementSystemId: sys, type: 'POLICY' }],
  OBJECTIVES: (sys) => ['objectives', { managementSystemId: sys, open: 'true' }],
  RISKS: (sys) => ['risks', { managementSystemId: sys }],
};

export type GateRow = {
  gate: CertificationGate;
  label: string;
  met: boolean;
  /** What is missing, in words. */
  missing: string[];
  href: string;
};

export type MissingContext = {
  unitNames: Record<string, string>;
  inputDefs: readonly Pick<IsoReviewInputDef, 'key' | 'title'>[];
};

const MAX_MISSING = 8;

/** One missing item of a gate (model §5.1: clause numbers, unit ids, input keys, objective ids or a risk kind). */
function missingWord(gate: CertificationGate, item: string, ctx: MissingContext): string {
  if (ctx.unitNames[item]) return ctx.unitNames[item];
  const input = ctx.inputDefs.find((d) => d.key === item);
  if (input) return input.title;
  if ((RiskKind.options as readonly string[]).includes(item)) {
    return `a ${word('RiskKind', item as RiskKind).toLowerCase()} in the risk register`;
  }
  if (/^\d+(\.\d+)*$/.test(item)) return `clause ${item}`;
  if (gate === 'OBJECTIVES') return 'an objective without a plan';
  return item;
}

/** The certification gates of one standard: met, or what is missing, with the page that fixes it. */
export function gateRows(
  clientId: string,
  systemId: string,
  gates: readonly GateResult[],
  ctx: MissingContext,
): GateRow[] {
  return gates.map((g) => {
    const [page, query] = GATE_PAGE[g.gate](systemId);
    const words = [...new Set(g.missing.map((m) => missingWord(g.gate, m, ctx)))];
    const shown = words.slice(0, MAX_MISSING);
    if (words.length > MAX_MISSING) shown.push(`and ${words.length - MAX_MISSING} more`);
    return {
      gate: g.gate,
      label: word('CertificationGate', g.gate),
      met: g.met,
      missing: shown,
      href:
        page === 'overview'
          ? `${isoPath(clientId, 'overview')}#system-setup`
          : hrefWith(isoPath(clientId, page), query),
    };
  });
}

/** A climate gap (Amd 1:2024) as the step that closes it. */
export function climateGapText(gap: ClimateGap): string {
  switch (gap) {
    case 'UNDECIDED':
      return 'Decide whether climate change is a relevant issue for this system (clause 4.1).';
    case 'RELEVANT_NO_RISK':
      return 'Climate change is relevant, but no risk, opportunity, aspect or hazard is marked as climate related.';
    case 'RELEVANT_NO_ISSUE':
      return 'Climate change is relevant, but no issue or interested party is marked as climate related.';
  }
}

export function climateGapHref(clientId: string, gap: ClimateGap): string {
  return gap === 'RELEVANT_NO_RISK'
    ? hrefWith(isoPath(clientId, 'risks'), { climateRelated: 'true' })
    : `${isoPath(clientId, 'overview')}#system-setup`;
}

/** "72.1%" or "No score yet". */
export function readinessText(score: number | null): string {
  return score === null ? 'No score yet' : `${score}%`;
}
