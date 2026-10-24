import { createHmac, randomBytes } from 'node:crypto';
import {
  createAdminDatabase,
  createDatabase,
  createOperatorDatabase,
  type AdminDatabase,
  type Database,
  type OperatorDatabase,
} from '@canopy/db';
import pg from 'pg';

/** For the operator API's Postgres tests: a throwaway, migrated database with the tenant and operator logins. */
export interface PlatformTestDatabase {
  url: string;
  admin: AdminDatabase;
  db: Database;
  operatorDb: OperatorDatabase;
  /** Reads as the database owner inside one account. Not every table forces its policy, so filter by firm too. */
  ownerQuery<T>(firmId: string, text: string): Promise<T[]>;
  drop(): Promise<void>;
}

export async function createPlatformTestDatabase(base: string): Promise<PlatformTestDatabase> {
  const name = `canopy_m15_${randomBytes(6).toString('hex')}`;
  const server = new pg.Client({ connectionString: base });
  await server.connect();
  await server.query(`CREATE DATABASE ${name}`);
  await server.end();
  const target = new URL(base);
  target.pathname = `/${name}`;
  const url = target.toString();
  const admin = createAdminDatabase({ connectionString: url });
  await admin.migrate();
  const db = createDatabase({ connectionString: url, max: 3 });
  const operatorDb = createOperatorDatabase({ connectionString: url, max: 3 });
  return {
    url,
    admin,
    db,
    operatorDb,
    async ownerQuery<T>(firmId: string, text: string) {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.firm_id', $1, true)`, [firmId]);
        const { rows } = await client.query(text);
        await client.query('COMMIT');
        return rows as T[];
      } finally {
        await client.end();
      }
    },
    async drop() {
      await Promise.all([db.close(), operatorDb.close(), admin.close()]);
      const cleanup = new pg.Client({ connectionString: base });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

/** RFC 6238 from an otpauth URI, written out here so the tests do not reuse the code under test. */
export function totpAt(uri: string, at: Date, stepOffset = 0): string {
  const secret = new URL(uri).searchParams.get('secret')!;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.floor(at.getTime() / 30_000) + stepOffset));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
