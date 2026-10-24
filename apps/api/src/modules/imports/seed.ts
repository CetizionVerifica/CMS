import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_CLIENT_SETTINGS,
  type Action,
  type Membership,
  type RequestContext,
  type Resource,
} from '@canopy/contracts';
import {
  clients,
  defineSeedHook,
  importBatches,
  memberships,
  people,
  systemContext,
  type Database,
} from '@canopy/db';
import { inferRule, localDateIn } from '@canopy/engine';
import { recommendedDecisions } from '@canopy/importer';
import { ApiError, can } from '../../auth/index.js';
import { MemoryImportFiles, uploadKey } from './files.js';
import { repositoryStore } from './service.js';
import { ImportSteps, type Actor } from './steps.js';

/**
 * `pnpm db:seed` hook (packages/db src/seed.ts): loads the anonymised sample register into seed firm A through
 * the same import steps a consultant runs, with the "recommended" profile (docs/contracts/fixtures.md §3), so
 * seeds never hand-write instance rows. A COMMITTED batch of the same file means it already ran. Logs counts only:
 * the register holds employee names.
 */

const SAMPLE = new URL(
  '../../../../../packages/importer/fixtures/sample-register-anonymised.xlsx',
  import.meta.url,
);
const FILE_NAME = 'sample-register-anonymised.xlsx';
/** Firm A's client and consultant, as in packages/contracts/fixtures/firm-a.sample.json. */
export const SEED_CLIENT_NAME = 'Kestrel Metals Group';
export const SEED_CONSULTANT = {
  displayName: 'Consultant 01',
  nameNormalized: 'consultant 01',
  email: 'consultant01@demo-advisory.example',
} as const;
/** A guard against a review that never settles; the sample needs a few dozen decisions. */
const MAX_DECISIONS = 1000;

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Firm A's client and consultant, created on the first run and found by name and email after it. */
async function clientAndConsultant(
  db: Database,
  firmId: string,
): Promise<{ clientId: string; personId: string; memberships: Membership[] }> {
  return db.withTenant(systemContext(firmId, 'seed-sample-register'), async (tx) => {
    const [existing] = await clients.findAll(tx, { name: SEED_CLIENT_NAME });
    const client =
      existing ??
      (await clients.create(tx, { name: SEED_CLIENT_NAME, settings: DEFAULT_CLIENT_SETTINGS }));
    const consultant = {
      role: 'CONSULTANT' as const,
      clientId: null,
      consultantClientIds: [client.id],
      unitIds: null,
      expiresAt: null,
    };
    const person = await people.findByEmail(tx, SEED_CONSULTANT.email);
    if (!person) {
      const created = await people.createWithMembership(
        tx,
        { ...SEED_CONSULTANT, status: 'ACTIVE' },
        consultant,
      );
      return {
        clientId: client.id,
        personId: created.person.id,
        memberships: [created.membership],
      };
    }
    let held = await memberships.forPerson(tx, person.id);
    const sees = held.some(
      (m) => m.role === 'CONSULTANT' && m.consultantClientIds?.includes(client.id),
    );
    if (!sees)
      held = [...held, await memberships.create(tx, { ...consultant, personId: person.id })];
    return { clientId: client.id, personId: person.id, memberships: held };
  });
}

function seedActor(firmId: string, personId: string, held: Membership[], clientId: string): Actor {
  const ctx: RequestContext = {
    requestId: 'seed-sample-register',
    firmId,
    personId,
    memberships: held,
    clientIds: [clientId],
    mfaSatisfied: true,
    asOf: localDateIn(new Date().toISOString(), DEFAULT_CLIENT_SETTINGS.timeZone),
  };
  return {
    ctx,
    authorize: (action: Action, resource: Resource) => {
      if (!can(ctx, action, resource)) throw new ApiError('FORBIDDEN', { action });
    },
  };
}

export default defineSeedHook({
  name: 'sample-register',
  async run({ db, firms, log }) {
    const firmId = firms.a.id;
    const bytes = new Uint8Array(await readFile(SAMPLE));
    const fileSha256 = sha256(bytes);
    const { clientId, personId, memberships: held } = await clientAndConsultant(db, firmId);
    const done = await db.withTenant(systemContext(firmId, 'seed-sample-register'), (tx) =>
      importBatches.findByFile(tx, clientId, fileSha256),
    );
    if (done.some((b) => b.status === 'COMMITTED')) {
      log('sample register: already imported');
      return;
    }

    const files = new MemoryImportFiles();
    const running: Promise<void>[] = [];
    const failures: unknown[] = [];
    const steps = new ImportSteps({
      store: repositoryStore(db),
      files,
      inferRule,
      runInBackground: (task) => running.push(task()),
      onBackgroundError: (error) => failures.push(error),
    });
    const settle = async () => {
      await Promise.all(running.splice(0));
      if (failures.length > 0) throw failures[0];
    };
    const actor = seedActor(firmId, personId, held, clientId);

    const ticket = await steps.start(actor, clientId, {
      fileName: FILE_NAME,
      sizeBytes: bytes.byteLength,
    });
    files.put(uploadKey(firmId, ticket.batchId), bytes);
    const preview = await steps.uploaded(actor, ticket.batchId, { sha256: fileSha256 });
    const sheetName = preview.sheets[0]?.name;
    const mapping = preview.suggestedMapping;
    if (!sheetName || !mapping) throw new Error('sample register: no sheet or mapping');
    await steps.setMapping(actor, ticket.batchId, { sheetName, mapping });
    await steps.parse(actor, ticket.batchId);
    await settle();

    // One group at a time: each decision re-runs the analysis, which can drop or add other groups.
    for (let n = 0; ; n++) {
      const { items } = await steps.issues(actor, ticket.batchId, { decision: ['PENDING'] });
      const group = items[0];
      if (!group) break;
      const decision = recommendedDecisions([group])[group.groupKey]?.decision;
      if (n >= MAX_DECISIONS || (decision !== 'ACCEPTED' && decision !== 'REJECTED')) {
        throw new Error(`sample register: ${group.type} needs a person to decide`);
      }
      await steps.decide(actor, ticket.batchId, group.groupKey, { decision });
    }
    const report = await steps.dryRun(actor, ticket.batchId);
    await steps.commit(actor, ticket.batchId);
    await settle();
    const batch = await steps.get(actor, ticket.batchId);
    if (batch.status !== 'COMMITTED') throw new Error(`sample register: batch ${batch.status}`);
    const { create } = report;
    log(
      `sample register: imported ${create.obligations} obligations, ${create.assignments} assignments, ` +
        `${create.instances} instances, ${create.people} people`,
    );
  },
});
