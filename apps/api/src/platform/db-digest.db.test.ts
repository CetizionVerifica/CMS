import { operators, subscriptions } from '@canopy/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecretBox } from '../auth/index.js';
import type { OutgoingEmail } from '../jobs/index.js';
import { OPERATOR_DIGEST, operatorDigestJob, runOperatorDigest } from './db-digest.js';
import { addOperator } from './db-operators.js';
import { createPlatformTestDatabase, type PlatformTestDatabase } from './db-testing.js';

// The operator's daily digest against Postgres 16 (CI `db` job), on the console's own login. 16 Nov 2026 04:00Z is
// 09:30 India time.
const url = process.env.DATABASE_URL;
const KEY = Buffer.alloc(32, 5).toString('base64');
const NOW = '2026-11-16T04:00:00.000Z';

describe.skipIf(!url)(OPERATOR_DIGEST, () => {
  let t: PlatformTestDatabase;
  let sent: OutgoingEmail[];
  const mailer = { send: async (email: OutgoingEmail) => void sent.push(email) };
  const deps = () => ({ db: t.operatorDb, mailer, clock: () => NOW });

  /** A firm with this status and trial end, set as the owner (the operator login cannot write `firm`). */
  async function account(name: string, status: string, trialEndsOn: string | null) {
    const id = await t.admin.createFirm({ name });
    await t.ownerQuery(
      id,
      `UPDATE firm SET status = '${status}', trial_ends_on = ${trialEndsOn ? `'${trialEndsOn}'` : 'NULL'} WHERE id = '${id}'`,
    );
    return id;
  }

  beforeAll(async () => {
    t = await createPlatformTestDatabase(url!);
    sent = [];
  });
  afterAll(async () => t?.drop());

  it('sends nothing on a day when no renewal is due', async () => {
    await addOperator(t.operatorDb, new SecretBox(KEY), {
      email: 'asha.ops@planetpulse.example',
      displayName: 'Asha Operator',
      password: 'operator password, long enough',
    });
    expect(await runOperatorDigest(deps(), 'job:digest:empty')).toEqual({
      due: 0,
      operators: 1,
      sent: 0,
    });
    expect(sent).toEqual([]);
  });

  it('emails each enabled operator the trials and subscriptions ending in 14 days', async () => {
    const secrets = new SecretBox(KEY);
    const away = await addOperator(t.operatorDb, secrets, {
      email: 'former.ops@planetpulse.example',
      displayName: 'Former Operator',
      password: 'operator password, long enough',
    });
    const [asha] = await t.operatorDb.withOperator('test', (tx) => operators.list(tx));
    await t.operatorDb.withOperator('test', (tx) =>
      operators.disable(tx, away.operator.id, '2026-11-01T00:00:00Z'),
    );
    await account('Kestrel Fibres', 'TRIAL', '2026-11-20');
    await account('Highmoor Fabrics', 'TRIAL', '2026-12-31'); // too far
    const paid = await account('Stonebridge Advisory', 'ACTIVE', null);
    await t.operatorDb.withOperator('test', (tx) =>
      subscriptions.record(tx, {
        accountId: paid,
        planCode: 'BUSINESS',
        startsOn: '2025-11-28',
        endsOn: '2026-11-27',
        amountPaise: 12_000_000,
        invoiceNumber: 'PP-2025-014',
        paidOn: '2025-11-28',
        recordedById: asha!.id,
      }),
    );

    expect(await runOperatorDigest(deps(), 'job:digest:1')).toEqual({
      due: 2,
      operators: 1,
      sent: 1,
    });
    expect(sent).toHaveLength(1);
    const [email] = sent;
    expect(email!.to).toEqual({ name: 'Asha Operator', email: 'asha.ops@planetpulse.example' });
    expect(email!.idempotencyKey).toBe(`${OPERATOR_DIGEST}:${asha!.id}:2026-11-16`);
    expect(email!.subject).toBe('Renewals due, 16 Nov 2026: 2 accounts');
    expect(email!.text).toContain('Kestrel Fibres: trial ends on 20 Nov 2026 (plan');
    expect(email!.text).toContain(
      'Stonebridge Advisory: subscription ends on 27 Nov 2026 (plan CONSULTANCY)',
    );
    expect(email!.text).not.toContain('Highmoor Fabrics');
    expect(email!.text.indexOf('Kestrel Fibres')).toBeLessThan(
      email!.text.indexOf('Stonebridge Advisory'),
    );
  });

  it('is a daily M9 job at 09:30 India time that needs a mailer', async () => {
    const job = operatorDigestJob(t.operatorDb);
    expect(job).toMatchObject({
      name: OPERATOR_DIGEST,
      cron: '30 9 * * *',
      tz: 'Asia/Kolkata',
      sendsMail: true,
    });
    sent = [];
    // The digest never opens a tenant: the jobs' store would throw if it did.
    const store = {
      listFirmIds: async () => [],
      withFirm: async () => {
        throw new Error('the operator digest reads no tenant');
      },
    };
    const report = await job.run(
      { store, mailer, clock: () => NOW, appUrl: 'https://app.example' },
      'job:digest:2',
    );
    expect(report).toMatchObject({ due: 2, sent: 1 });
    expect(sent).toHaveLength(1);
  });
});
