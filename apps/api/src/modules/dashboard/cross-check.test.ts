import { randomUUID } from 'node:crypto';
import {
  DEFAULT_FIRM_SETTINGS,
  DerivedStatus,
  ENDPOINTS,
  type Breakdown,
  type LocalDate,
} from '@canopy/contracts';
import { asLocalDate, summarizeKpis } from '@canopy/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestAuth } from '../../auth/testing.js';
import { buildServer } from '../../server.js';
import { rowStatus } from '../instances/status.js';
import { loadSample, type SampleClient } from './fixtures.js';
import { MemoryReportsStore, type MemoryRow } from './memory-store.js';

/**
 * MODULES.md M10 acceptance: each KPI equals the matching filtered instance count from M7. On the sample
 * register, every dashboard number is compared with the register filtered the way M7 filters it: the
 * period's rows, the group's rows, then M7's own `rowStatus` (the status column of every register row).
 */

const NOW = new Date('2026-10-12T06:00:00Z');
const store = new MemoryReportsStore(() => NOW);
const { store: authStore, signIn } = createTestAuth();
const app = buildServer({ authStore, clock: () => NOW, reports: { store } });
let sample: SampleClient;
let headers: Record<string, string>;

beforeAll(async () => {
  const firmId = randomUUID();
  sample = await loadSample(store, firmId);
  headers = signIn({
    firmId,
    memberships: [{ role: 'FIRM_ADMIN' }],
    principal: { firmClientIds: [sample.clientId] },
  }).headers;
});
afterAll(() => app.close());

/** M7's register filtered by status: the rows of `rows` whose register status column is `status`. */
function registerIds(rows: readonly MemoryRow[], status: DerivedStatus, asOf: LocalDate): string[] {
  return rows
    .filter((r) => rowStatus(r, asOf, DEFAULT_FIRM_SETTINGS).status === status)
    .map((r) => r.id)
    .sort();
}

const inFy = (r: MemoryRow) => r.dueDate >= '2022-04-01' && r.dueDate <= '2023-03-31';

// Before, during and after the sample's FY 2022-23, and on its quarter and FY boundaries.
const AS_OF = ['2022-03-31', '2022-06-30', '2022-07-01', '2022-12-15', '2023-03-31', '2023-04-01'];

describe.each(AS_OF)('as at %s, FY 2022-23', (asOfText) => {
  const asOf = asLocalDate(asOfText);
  const query = `fy=2022-23&asOf=${asOf}`;

  it('overview counts equal the register filtered by status', async () => {
    const res = await app.inject({
      url: `/api/v1/clients/${sample.clientId}/overview?${query}`,
      headers,
    });
    const { result } = ENDPOINTS.clientOverview.response.parse(res.json());
    const rows = sample.rows.filter(inFy);
    expect(rows).toHaveLength(422);
    for (const status of DerivedStatus.options) {
      const expected = registerIds(rows, status, asOf);
      expect([...result.instanceIds[status]].sort()).toEqual(expected);
      expect(result.counts[status]).toBe(expected.length);
    }
    // The KPI tiles (open, overdue, due this week, awaiting approval) are sums of the same filters.
    const kpis = summarizeKpis(result);
    expect(kpis.overdue.count).toBe(registerIds(rows, 'OVERDUE', asOf).length);
    expect(kpis.dueSoon.count).toBe(registerIds(rows, 'DUE_SOON', asOf).length);
    expect(kpis.awaitingApproval.count).toBe(registerIds(rows, 'SUBMITTED', asOf).length);
    expect(kpis.open.count).toBe(
      (['UPCOMING', 'DUE_SOON', 'OVERDUE'] as const).reduce(
        (sum, s) => sum + registerIds(rows, s, asOf).length,
        0,
      ),
    );
  });

  it.each([
    ['department', (r: MemoryRow) => r.departmentId],
    ['act', (r: MemoryRow) => r.actId],
    ['criticality', (r: MemoryRow) => r.criticality],
    ['unit', (r: MemoryRow) => r.unitId],
    ['owner', (r: MemoryRow) => r.ownerId],
  ] as const)('%s breakdown rows equal the register filtered by that column', async (by, key) => {
    const res = await app.inject({
      url: `/api/v1/clients/${sample.clientId}/breakdowns?by=${by}&${query}`,
      headers,
    });
    const breakdown: Breakdown = ENDPOINTS.breakdown.response.parse(res.json());
    const rows = sample.rows.filter(inFy);
    expect(breakdown.rows.map((r) => r.key).sort()).toEqual([...new Set(rows.map(key))].sort());
    for (const group of breakdown.rows) {
      const groupRows = rows.filter((r) => key(r) === group.key);
      for (const status of DerivedStatus.options) {
        expect([...group.result.instanceIds[status]].sort()).toEqual(
          registerIds(groupRows, status, asOf),
        );
      }
    }
  });
});

describe('sample register, FY 2022-23 as at 2023-03-31', () => {
  it('matches the register status split: 209 complied, 201 pending, 12 not applicable', async () => {
    const res = await app.inject({
      url: `/api/v1/clients/${sample.clientId}/overview?fy=2022-23&asOf=2023-03-31`,
      headers,
    });
    const { counts, score } = res.json().result;
    // 422 instances after the recommended merges: the two folded repeats were Complied rows.
    expect(counts.COMPLIED + counts.COMPLIED_LATE).toBe(209);
    expect(counts.COMPLIED_LATE).toBe(0);
    expect(counts.NOT_APPLICABLE).toBe(12);
    expect(counts.OVERDUE + counts.DUE_SOON + counts.UPCOMING).toBe(201);
    expect(score).not.toBeNull();
  });

  it('portfolio and overview give the same result for the client', async () => {
    const q = 'fy=2022-23&asOf=2022-12-15';
    const overview = await app.inject({
      url: `/api/v1/clients/${sample.clientId}/overview?${q}`,
      headers,
    });
    const portfolio = await app.inject({ url: `/api/v1/portfolio?${q}`, headers });
    expect(portfolio.json().items[0].result).toEqual(overview.json().result);
  });
});
