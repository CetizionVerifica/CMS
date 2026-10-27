import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness, type Who } from './testing/fixture.js';
import { seedAction, seedNc, setNcState } from './testing/records.js';

/**
 * The ISO overview (model §5.1-5.2): the systems the actor can see by name, `asOf` for FA, CO and VIEWER only, every
 * number from the engine with the ids behind it, and the counts cut to the records the actor may read (plan §3.3).
 */

const NOW = new Date('2026-10-20T06:00:00Z');
let h: Harness;
/** Unit A only. */
let alpha: string;
/** Both units. */
let both: string;
/** Unit B only. */
let beta: string;

beforeAll(async () => {
  h = await createHarness('Overview', NOW);
  const system = async (name: string, unitIds: string[]) => {
    const id = (
      await h.ok('clientAdmin', 'POST', '/systems', {
        name,
        standardIds: [h.f.std14001, h.f.std9001],
        unitIds,
      })
    ).id as string;
    await h.testDb.query('UPDATE management_system SET created_at = $2 WHERE id = $1', [
      id,
      '2026-01-05T06:00:00Z',
    ]);
    return id;
  };
  beta = await system('Highmoor system', [h.f.unitB]);
  alpha = await system('Alpha plant system', [h.f.unitA]);
  both = await system('Both plants system', [h.f.unitA, h.f.unitB]);
}, 120_000);

afterAll(async () => {
  await h?.close();
});

type Count = { count: number; ids: string[] };
type SystemOverview = {
  managementSystemId: string;
  standardIds: string[];
  clauseReadiness: { byStandard: { standardId: string }[] };
  certificationReadiness: { standards: { standardId: string; ready: boolean }[] };
  climateGaps: string[];
  nonconformities: Record<
    'open' | 'overdue' | 'awaitingVerification' | 'effectivenessOverdue',
    Count
  >;
  actions: Record<'open' | 'overdue', Count>;
  managementReview: { items: { standard: string; lastHeldOn: string | null; nextDueOn: string }[] };
  certificates: Record<'expiringSoon' | 'cycleOverdue', Count>;
  incidents: { from: string; to: string; total: Count };
  auditProgramme: { fy: string } | null;
};

async function overview(who: Who = 'clientAdmin', query = '') {
  const body = await h.ok(who, 'GET', `/overview${query}`);
  return body as { asOf: string; systems: SystemOverview[] };
}
const of = async (systemId: string, who: Who = 'clientAdmin') =>
  (await overview(who, `?managementSystemId=${systemId}`)).systems[0]!;

describe('getIsoOverview', () => {
  it('lists the systems the actor can see by name, as of today unless a firm role or viewer sets it', async () => {
    const all = await overview();
    expect(all.asOf).toBe('2026-10-20');
    expect(all.systems.map((s) => s.managementSystemId)).toEqual([alpha, both, beta]);
    expect((await overview('owner')).systems.map((s) => s.managementSystemId)).toEqual([
      alpha,
      both,
    ]);
    expect((await overview('viewer', '?asOf=2026-09-30')).asOf).toBe('2026-09-30');
    expect((await overview('consultant', '?asOf=2026-09-30')).asOf).toBe('2026-09-30');
    for (const who of ['owner', 'clientAdmin', 'approver'] as const) {
      const reply = await h.send(who, 'GET', '/overview?asOf=2026-09-30');
      expect([who, reply.status]).toEqual([who, 403]);
    }
    const one = await overview('clientAdmin', `?managementSystemId=${beta}`);
    expect(one.systems.map((s) => s.managementSystemId)).toEqual([beta]);
  });

  it('reads each standard in the order the system lists them', async () => {
    const s = await of(alpha);
    expect(s.standardIds).toEqual([h.f.std14001, h.f.std9001]);
    expect(s.clauseReadiness.byStandard.map((b) => b.standardId)).toEqual(s.standardIds);
    expect(s.certificationReadiness.standards.map((b) => b.standardId)).toEqual(s.standardIds);
    expect(s.climateGaps).toEqual(['UNDECIDED']);
    expect(s.managementReview.items).toEqual([
      expect.objectContaining({ standard: 'ISO_14001', lastHeldOn: null, nextDueOn: '2027-01-05' }),
      expect.objectContaining({ standard: 'ISO_9001', lastHeldOn: null, nextDueOn: '2027-01-05' }),
    ]);
    expect(s.auditProgramme).toBeNull();
    expect(s.incidents).toMatchObject({ from: '2026-04-01', to: '2027-03-31' });
  });

  it('takes nonconformity and action timing from the engine', async () => {
    // Its own due date is ahead, but an OPEN action is past due: the NC is overdue (model §5.2).
    const byAction = await seedNc(h, alpha, { unitId: h.f.unitA, dueOn: '2026-12-15' as never });
    const late = await seedAction(
      h,
      { type: 'NONCONFORMITY', id: byAction.id },
      {
        dueOn: '2026-10-01' as never,
      },
    );
    const pastDue = await seedNc(h, alpha, {
      unitId: h.f.unitA,
      dueOn: '2026-10-01' as never,
      reportedOn: '2026-09-20' as never,
    });
    // Awaiting verification, its own due date no longer counts; its effectiveness check is late.
    const awaiting = await seedNc(h, alpha, {
      unitId: h.f.unitA,
      dueOn: '2026-10-01' as never,
      reportedOn: '2026-09-20' as never,
      state: 'AWAITING_VERIFICATION',
      containment: 'Quarantined',
      correction: 'Recalibrated',
      rootCauseMethod: 'FIVE_WHYS',
      rootCause: 'No schedule',
      similarOccurrences: 'None',
      riskReview: 'None',
      systemChange: 'None',
      effectivenessDueOn: '2026-10-10' as never,
    });
    const closed = await seedNc(h, alpha, {
      unitId: h.f.unitA,
      dueOn: '2026-10-01' as never,
      reportedOn: '2026-09-20' as never,
    });
    await setNcState(h, closed, 'CLOSED');

    const s = await of(alpha);
    expect(s.nonconformities.open.ids.sort()).toEqual(
      [byAction.id, pastDue.id, awaiting.id].sort(),
    );
    expect(s.nonconformities.overdue.ids.sort()).toEqual([byAction.id, pastDue.id].sort());
    // The same NCs the NC list's own overdue filter gives the same reader (contracts 1.8.6).
    for (const who of ['clientAdmin', 'owner'] as const) {
      const listed = (
        (
          await h.ok(
            who,
            'GET',
            `/nonconformities?managementSystemId=${alpha}&overdue=true&limit=200`,
          )
        ).items as { id: string }[]
      ).map((n) => n.id);
      const counted = (await of(alpha, who)).nonconformities.overdue.ids;
      expect([who, counted.sort()]).toEqual([who, listed.sort()]);
    }
    expect(s.nonconformities.awaitingVerification.ids).toEqual([awaiting.id]);
    expect(s.nonconformities.effectivenessOverdue.ids).toEqual([awaiting.id]);
    expect(s.actions).toMatchObject({
      open: { count: 1, ids: [late.id] },
      overdue: { count: 1, ids: [late.id] },
    });
    // As at an earlier day nothing is late yet.
    const earlier = (await overview('viewer', `?asOf=2026-09-01&managementSystemId=${alpha}`))
      .systems[0]!;
    expect(earlier.nonconformities.overdue.count).toBe(0);
    expect(earlier.actions.overdue.count).toBe(0);
  });

  it('counts only what the reader may read', async () => {
    const atB = await seedNc(h, both, {
      unitId: h.f.unitB,
      ownerId: h.f.people.otherOwner,
      approverId: h.f.people.approverB,
    });
    const atA = await seedNc(h, both, { unitId: h.f.unitA });
    expect((await of(both)).nonconformities.open.ids.sort()).toEqual([atA.id, atB.id].sort());
    expect((await of(both, 'owner')).nonconformities.open).toEqual({ count: 1, ids: [atA.id] });
    expect((await of(both, 'otherOwner')).nonconformities.open).toEqual({
      count: 1,
      ids: [atB.id],
    });
  });

  it("counts the incidents of the client's current FY, cancelled ones left out", async () => {
    const incident = (occurredAt: string) => ({
      occurredAt,
      location: 'Press shop',
      type: 'INJURY' as const,
      outcome: 'FIRST_AID' as const,
      personCategory: null,
      lostDays: null,
      reportable: false,
      statutoryInstanceId: null,
      investigatorIds: [],
      workerParticipation: false,
    });
    const seed = (occurredAt: string) =>
      seedNc(h, beta, {
        source: 'INCIDENT',
        unitId: h.f.unitB,
        ownerId: h.f.people.otherOwner,
        approverId: h.f.people.approverB,
        incident: incident(occurredAt),
      });
    const inYear = await seed('2026-05-01T04:00:00Z');
    await seed('2026-03-31T04:00:00Z');
    const cancelled = await seed('2026-06-01T04:00:00Z');
    await setNcState(h, cancelled, 'CANCELLED');
    expect((await of(beta)).incidents.total).toEqual({ count: 1, ids: [inYear.id] });
    expect((await of(beta, 'otherOwner')).incidents.total.count).toBe(1);
  });

  it('flags certificates expiring within 90 days and cycle dates overdue', async () => {
    const cert = await h.ok('clientAdmin', 'POST', '/certifications', {
      managementSystemId: alpha,
      standardId: h.f.std9001,
      body: 'Northwind Certification',
      certificateNumber: 'NW-0042',
      issuedOn: '2024-01-10',
      expiresOn: '2026-12-01',
    });
    const s = await of(alpha);
    expect(s.certificates).toEqual({
      expiringSoon: { count: 1, ids: [cert.id] },
      cycleOverdue: { count: 1, ids: [cert.id] },
    });
    // Past its expiry it no longer counts as expiring soon.
    const later = (await overview('viewer', `?asOf=2026-12-02&managementSystemId=${alpha}`))
      .systems[0]!;
    expect(later.certificates.expiringSoon.count).toBe(0);
  });

  it('dates the next management review from the last one held', async () => {
    const review = await h.ok('clientAdmin', 'POST', '/management-reviews', {
      managementSystemId: beta,
      standards: ['ISO_9001'],
      plannedOn: '2026-10-01',
      chairId: h.f.people.clientAdmin,
      attendeeIds: [h.f.people.approverB],
    });
    const { items } = (await h.ok(
      'clientAdmin',
      'GET',
      `/management-reviews/${review.id}/inputs`,
    )) as {
      items: { id: string; version: number }[];
    };
    for (const row of items) {
      await h.ok('clientAdmin', 'PATCH', `/management-reviews/${review.id}/inputs/${row.id}`, {
        version: row.version,
        notes: 'Discussed',
      });
    }
    await h.ok('clientAdmin', 'POST', `/management-reviews/${review.id}/held`, {
      version: 1,
      heldOn: '2026-10-01',
    });
    expect((await of(beta)).managementReview.items).toEqual([
      expect.objectContaining({ standard: 'ISO_14001', lastHeldOn: null }),
      expect.objectContaining({
        standard: 'ISO_9001',
        lastHeldOn: '2026-10-01',
        nextDueOn: '2027-10-01',
      }),
    ]);
  });
});
