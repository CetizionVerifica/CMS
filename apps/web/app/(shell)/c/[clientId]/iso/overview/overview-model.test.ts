import type { GateResult } from '@canopy/contracts';
import { describe, expect, it } from 'vitest';

import { ISO } from '../_test/fixture';
import {
  climateGapHref,
  climateGapText,
  countGroups,
  gateRows,
  isoPath,
  MAX_LINK_IDS,
  readinessLinks,
  readinessText,
} from './overview-model';

const C = 'client-1';
const view = ISO.overview.systems[0]!;
const SYS = view.managementSystemId;

describe('countGroups', () => {
  it('links each number to exactly the records it counts', () => {
    const groups = countGroups(C, view);
    expect(groups.map((g) => g.title)).toEqual([
      'Nonconformities',
      'Actions',
      'Documents',
      'Risks',
      'Objectives',
      'Certificates',
    ]);
    const all = groups.flatMap((g) => g.items);
    expect(all.find((i) => i.label === 'Revision in review')).toEqual({
      label: 'Revision in review',
      count: view.documents.inReview.count,
      href: `/c/${C}/iso/documents?ids=${view.documents.inReview.ids.join('%2C')}`,
    });
    expect(groups[0]!.items[1]!.href).toBe(
      `/c/${C}/iso/nonconformities?managementSystemId=${SYS}&overdue=true`,
    );
    expect(groups[1]!.items[0]!.href).toBe(
      `/c/${C}/iso/actions?managementSystemId=${SYS}&state=OPEN`,
    );
    for (const item of all) expect(item.href.startsWith(`/c/${C}/iso/`)).toBe(true);
    expect(all.some((i) => i.note)).toBe(false);
  });

  it("opens the system's whole list, and says so, past the ids filter's limit", () => {
    const many = Array.from({ length: MAX_LINK_IDS + 1 }, (_, i) => `r${i}`);
    const groups = countGroups(C, {
      ...view,
      risks: { ...view.risks, reviewOverdue: { count: many.length, ids: many } },
    });
    const item = groups.find((g) => g.title === 'Risks')!.items[1]!;
    expect(item.href).toBe(`/c/${C}/iso/risks?managementSystemId=${SYS}`);
    expect(item.note).toMatch(/all of the system's records/);
    const atLimit = countGroups(C, {
      ...view,
      risks: { ...view.risks, reviewOverdue: { count: 200, ids: many.slice(0, 200) } },
    });
    expect(atLimit.find((g) => g.title === 'Risks')!.items[1]!.href).toMatch(/\?ids=r0%2C/);
    // Past the limit the documents list is asked for every status, not its ACTIVE-only default.
    const docs = countGroups(C, {
      ...view,
      documents: { ...view.documents, reviewOverdue: { count: many.length, ids: many } },
    });
    expect(docs.find((g) => g.title === 'Documents')!.items[1]!.href).toBe(
      `/c/${C}/iso/documents?managementSystemId=${SYS}&status=ACTIVE%2COBSOLETE`,
    );
  });
});

describe('readinessLinks', () => {
  it('counts the ids and filters the checklist of the system by status or N/A state', () => {
    const links = readinessLinks(C, SYS, 'std', {
      implemented: ['a', 'b'],
      partial: ['c'],
      notStarted: [],
      naPending: ['d'],
      excluded: ['e', 'f', 'g'],
    });
    expect(links.map((l) => [l.label, l.count])).toEqual([
      ['Implemented', 2],
      ['Partial', 1],
      ['Not started', 0],
      ['Not applicable requested', 1],
      ['Excluded', 3],
    ]);
    expect(links[0]!.href).toBe(
      `/c/${C}/iso/checklist?system=${SYS}&standardId=std&status=IMPLEMENTED`,
    );
    expect(links[4]!.href).toBe(
      `/c/${C}/iso/checklist?system=${SYS}&standardId=std&naState=APPROVED`,
    );
  });
});

describe('gateRows', () => {
  const ctx = {
    unitNames: { u1: 'Pune Plant' },
    inputDefs: [{ key: 'PREVIOUS_ACTIONS' as const, title: 'Actions from previous reviews' }],
  };
  const gate = (g: Partial<GateResult> & Pick<GateResult, 'gate'>): GateResult =>
    ({ met: false, missing: [], ...g }) as GateResult;

  it('words what is missing and links the page that fixes it', () => {
    const rows = gateRows(
      C,
      SYS,
      [
        gate({ gate: 'INTERNAL_AUDIT', missing: ['4.1', 'u1', '4.1'] }),
        gate({ gate: 'MANAGEMENT_REVIEW', missing: ['PREVIOUS_ACTIONS'] }),
        gate({ gate: 'SCOPE', met: true }),
        gate({ gate: 'POLICY', missing: ['x'] }),
        gate({ gate: 'OBJECTIVES', missing: ['00000000-0000-5000-8000-000000000001'] }),
        gate({ gate: 'RISKS', missing: ['HAZARD'] }),
      ],
      ctx,
    );
    expect(rows[0]).toMatchObject({
      label: 'Internal audit',
      met: false,
      missing: ['clause 4.1', 'Pune Plant'],
      href: `/c/${C}/iso/audits`,
    });
    expect(rows[1]!.missing).toEqual(['Actions from previous reviews']);
    expect(rows[2]).toMatchObject({ met: true, href: `/c/${C}/iso/overview#system-setup` });
    expect(rows[3]).toMatchObject({
      missing: ['x'],
      href: `/c/${C}/iso/documents?managementSystemId=${SYS}&type=POLICY`,
    });
    expect(rows[4]!.missing).toEqual(['an objective without a plan']);
    expect(rows[5]!.missing).toEqual(['a hazard in the risk register']);
  });

  it('shows at most eight, then says how many more', () => {
    const missing = Array.from({ length: 11 }, (_, i) => `4.${i + 1}`);
    const [row] = gateRows(C, SYS, [gate({ gate: 'INTERNAL_AUDIT', missing })], ctx);
    expect(row!.missing).toHaveLength(9);
    expect(row!.missing.at(-1)).toBe('and 3 more');
  });
});

describe('climate and readiness words', () => {
  it('says the step that closes each climate gap and where to take it', () => {
    expect(climateGapText('UNDECIDED')).toMatch(/^Decide whether climate change/);
    expect(climateGapText('RELEVANT_NO_RISK')).toMatch(/no risk/);
    expect(climateGapText('RELEVANT_NO_ISSUE')).toMatch(/no issue/);
    expect(climateGapHref(C, 'RELEVANT_NO_RISK')).toBe(`/c/${C}/iso/risks?climateRelated=true`);
    expect(climateGapHref(C, 'UNDECIDED')).toBe(`/c/${C}/iso/overview#system-setup`);
    expect(readinessText(null)).toBe('No score yet');
    expect(readinessText(72.1)).toBe('72.1%');
    expect(isoPath(C, 'checklist')).toBe(`/c/${C}/iso/checklist`);
  });
});
