import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  ENDPOINTS,
  ImportRow,
  InstanceRow,
  Obligation,
  ScoreResult,
  tolerant,
  type TolerantOutput,
  UNKNOWN,
} from '../src/index.js';
import { ID, obligation, without } from './samples.js';

const ids = (n: number) => Array.from({ length: n }, () => ID.instance);

const score = {
  engineVersion: '1.0.0',
  asOf: '2023-03-31',
  score: 50,
  onTimeRate: 50,
  counts: {
    COMPLIED: 1,
    COMPLIED_LATE: 0,
    SUBMITTED: 0,
    OVERDUE: 1,
    DUE_SOON: 0,
    UPCOMING: 0,
    NOT_APPLICABLE: 0,
  },
  instanceIds: {
    COMPLIED: ids(1),
    COMPLIED_LATE: [],
    SUBMITTED: [],
    OVERDUE: ids(1),
    DUE_SOON: [],
    UPCOMING: [],
    NOT_APPLICABLE: [],
  },
};

describe('tolerant response schemas', () => {
  const ClientObligation = tolerant(Obligation);

  it('still parses a valid response unchanged', () => {
    expect(ClientObligation.parse(obligation)).toEqual(obligation);
  });

  it('keeps fields a newer server adds', () => {
    const parsed = ClientObligation.parse({ ...obligation, riskNote: 'new in 1.2' }) as Record<
      string,
      unknown
    >;
    expect(parsed.riskNote).toBe('new in 1.2');
    expect(Obligation.safeParse({ ...obligation, riskNote: 'x' }).success).toBe(false);
  });

  it('reads an unknown enum value as UNKNOWN', () => {
    expect(ClientObligation.parse({ ...obligation, criticality: 'EXTREME' }).criticality).toBe(
      UNKNOWN,
    );
    expect(ClientObligation.parse({ ...obligation, criticality: 'LOW' }).criticality).toBe('LOW');
  });

  it('reads an unknown recurrence kind as { kind: UNKNOWN }', () => {
    const parsed = ClientObligation.parse({
      ...obligation,
      recurrenceRule: { kind: 'BIENNIAL', everyYears: 2 },
    });
    expect(parsed.recurrenceRule).toEqual({ kind: UNKNOWN, everyYears: 2 });
  });

  it('still rejects a known recurrence kind with a wrong shape', () => {
    expect(
      ClientObligation.safeParse({
        ...obligation,
        recurrenceRule: { kind: 'MONTHLY', day: 'first' },
      }).success,
    ).toBe(false);
  });

  it('still rejects a wrong type in a known field', () => {
    expect(ClientObligation.safeParse({ ...obligation, evidenceRequired: 'yes' }).success).toBe(
      false,
    );
    expect(ClientObligation.safeParse({ ...obligation, criticality: 7 }).success).toBe(false);
  });

  it('accepts extra keys in an enum-keyed record but keeps the known keys required', () => {
    const Client = tolerant(ScoreResult);
    const withNew = {
      ...score,
      counts: { ...score.counts, ESCALATED: 0 },
      instanceIds: { ...score.instanceIds, ESCALATED: [] },
    };
    expect(Client.safeParse(withNew).success).toBe(true);
    expect(Client.safeParse({ ...score, counts: without(score.counts, 'OVERDUE') }).success).toBe(
      false,
    );
  });

  it('keeps partial records partial', () => {
    const Client = tolerant(ImportRow);
    const row = {
      id: ID.instance,
      batchId: ID.client,
      rowNumber: 2,
      raw: { Title: 'Deposit TDS' },
      mapped: { title: 'Deposit TDS', futureField: 'x' },
      issueIds: [],
      outcome: 'PENDING',
      targetInstanceId: null,
    };
    expect(Client.parse(row).mapped).toEqual({ title: 'Deposit TDS', futureField: 'x' });
  });

  it('drops cross-field rules, which the server enforces', () => {
    const inconsistent = { ...score, counts: { ...score.counts, OVERDUE: 5 } };
    expect(ScoreResult.safeParse(inconsistent).success).toBe(false);
    expect(tolerant(ScoreResult).safeParse(inconsistent).success).toBe(true);
  });

  it('reuses one derived schema per source schema', () => {
    expect(tolerant(InstanceRow)).toBe(tolerant(InstanceRow));
  });

  it('works on every endpoint response', () => {
    for (const ep of Object.values(ENDPOINTS)) {
      expect(tolerant(ep.response)).toBeInstanceOf(z.ZodType);
    }
  });

  it('types unknown enum values and unknown recurrence kinds', () => {
    type ClientObligation = TolerantOutput<typeof Obligation>;
    expectTypeOf<ClientObligation['criticality']>().toEqualTypeOf<
      'SUPER_CRITICAL' | 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN'
    >();
    expectTypeOf<{ kind: 'UNKNOWN' }>().toExtend<ClientObligation['recurrenceRule']>();
  });
});
