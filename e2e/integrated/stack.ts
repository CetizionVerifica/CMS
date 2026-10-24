import { fileURLToPath } from 'node:url';

// The integrated stack's fixed facts, shared by the Playwright config, the database preparation and the journeys.
// Everything here is test data for a throwaway database: fictional names only, never a real client.

/** The API and web app of the integrated run listen here, beside the demo run's 4000 and 3000. */
export const API_PORT = 4100;
export const WEB_PORT = 3100;
export const API_URL = `http://localhost:${API_PORT}`;
export const WEB_URL = `http://localhost:${WEB_PORT}`;

/** The database the run recreates on the server `DATABASE_URL` points at, and the app login it serves through. */
export const E2E_DATABASE = 'canopy_e2e';
export const APP_LOGIN = 'canopy_e2e_app';
export const APP_PASSWORD = 'e2e-app-login';
/** pg-boss's own login (JOBS_DATABASE_URL, ADR M9-0001 decision 16): a member of canopy_jobs, never the app login. */
export const JOBS_LOGIN = 'canopy_e2e_jobs';
export const JOBS_PASSWORD = 'e2e-jobs-login';

/** The stand-in clamd (fake-clamd.ts) the API's evidence scan calls (CLAMAV_HOST, docs/security/review.md F8). */
export const CLAMD_PORT = 4110;
/**
 * EICAR's anti-virus test string: harmless, and every scanner reports it. Joined at run time, so a desktop scanner does
 * not quarantine this file in a checkout.
 */
export const EICAR = [
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR',
  '-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
].join('');

/** Test-only key: 32 bytes of 9. */
export const AUTH_SECRET_KEY = Buffer.alloc(32, 9).toString('base64');

export const PASSWORD = 'integrated journey password';

/**
 * Firm A and B are `SEED_FIRMS` from @canopy/db (fixed ids; prepare.ts checks they still match). Firm A has the client
 * Kestrel Metals Group, firm B Osprey Textiles Group; their generated ids are in `seed.json` under `RUN_DIR`. The owner's
 * and approver's names match an owner and approver in the anonymised sample register, so its import assigns their
 * rows to them.
 */
export const FIRM_A = '01920000-0000-7000-8000-00000000a001';
export const FIRM_B = '01920000-0000-7000-8000-00000000b001';

export interface Account {
  readonly key: string;
  readonly firmId: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: 'FIRM_ADMIN' | 'CONSULTANT' | 'CLIENT_ADMIN' | 'APPROVER' | 'OWNER' | 'VIEWER';
}

export const ACCOUNTS = {
  firmAdmin: {
    key: 'firmAdmin',
    firmId: FIRM_A,
    displayName: 'Meera Advisor',
    email: 'admin@demo-advisory.test',
    role: 'FIRM_ADMIN',
  },
  consultant: {
    key: 'consultant',
    firmId: FIRM_A,
    displayName: 'Ravi Consultant',
    email: 'consultant@demo-advisory.test',
    role: 'CONSULTANT',
  },
  clientAdmin: {
    key: 'clientAdmin',
    firmId: FIRM_A,
    displayName: 'Kiran Kestrel',
    email: 'admin@kestrel.test',
    role: 'CLIENT_ADMIN',
  },
  owner: {
    key: 'owner',
    firmId: FIRM_A,
    displayName: 'Person Mike',
    email: 'mike@kestrel.test',
    role: 'OWNER',
  },
  approver: {
    key: 'approver',
    firmId: FIRM_A,
    displayName: 'Person Oscar',
    email: 'oscar@kestrel.test',
    role: 'APPROVER',
  },
  viewer: {
    key: 'viewer',
    firmId: FIRM_A,
    displayName: 'Vani Viewer',
    email: 'viewer@kestrel.test',
    role: 'VIEWER',
  },
  ospreyFirmAdmin: {
    key: 'ospreyFirmAdmin',
    firmId: FIRM_B,
    displayName: 'Lena Ledger',
    email: 'admin@second-ledger.test',
    role: 'FIRM_ADMIN',
  },
  ospreyAdmin: {
    key: 'ospreyAdmin',
    firmId: FIRM_B,
    displayName: 'Omar Osprey',
    email: 'admin@osprey.test',
    role: 'CLIENT_ADMIN',
  },
} as const satisfies Record<string, Account>;

export type AccountKey = keyof typeof ACCOUNTS;

/**
 * Each account browses from its own address (sent as X-Forwarded-For, which the web app passes on and the API
 * trusts from the loopback web server), so the API's per-IP rate limits count people, as in production. `visit`
 * gives each journey its own address too: one firm user's page views currently cost far more API calls than the
 * limit allows per minute (docs/security/review.md F7), and a fresh address per journey keeps the suite from
 * tripping it. Drop `visit` once F7 is fixed.
 */
export const addressOf = (key: AccountKey, visit = 0) =>
  `198.51.${100 + (visit % 100)}.${Object.keys(ACCOUNTS).indexOf(key) + 10}`;

/**
 * Where a run keeps what it generates (seeded ids, signed-in browser states): under node_modules/.cache, so neither
 * git nor Prettier sees it.
 */
export const RUN_DIR = new URL('../node_modules/.cache/integrated/', import.meta.url);

/** Where each account's signed-in browser state is saved by the setup project. */
export const storageStateOf = (key: AccountKey) =>
  fileURLToPath(new URL(`auth/${key}.json`, RUN_DIR));

/** Where the setup project keeps a firm user's TOTP secret, from the API's enrolment, as their authenticator would. */
export const totpSecretFileOf = (key: AccountKey) => new URL(`auth/${key}.totp`, RUN_DIR);

/** `DATABASE_URL` with its database swapped, e.g. for the e2e database or the app login. */
export function databaseUrl(base: string, database: string, login?: [string, string]): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  if (login) {
    url.username = login[0];
    url.password = login[1];
  }
  return url.toString();
}
