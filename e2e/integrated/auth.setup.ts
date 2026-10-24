import { mkdirSync, writeFileSync } from 'node:fs';

import { expect, request, test as setup } from '@playwright/test';

import { checkPage, isFirmRole, signIn } from './helpers.js';
import {
  ACCOUNTS,
  API_URL,
  PASSWORD,
  addressOf,
  storageStateOf,
  totpSecretFileOf,
  type AccountKey,
} from './stack.js';
import { nextUnusedCode } from './totp.js';

// Signs every seeded account in once through the real login page (and the code step for firm roles), and saves the
// browser state the journeys reuse. The import journey runs first among the specs because the others need its
// register.

/**
 * Firm roles must enrol in MFA before their first sign-in completes. The web app has no enrolment screen yet
 * (docs/security/review.md F12), so this enrols through the API as that screen would: sign in with the password,
 * start enrolment, confirm a code. The secret is kept for the sign-ins that follow, as an authenticator keeps it.
 */
async function enrolMfa(key: AccountKey): Promise<void> {
  const http = await request.newContext({
    baseURL: API_URL,
    extraHTTPHeaders: { 'x-forwarded-for': addressOf(key) },
  });
  const login = await http.post('/api/v1/auth/login', {
    data: { email: ACCOUNTS[key].email, password: PASSWORD },
  });
  expect(login.status()).toBe(200);
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  const headers = { 'x-csrf-token': csrfToken };
  const enrol = await http.post('/api/v1/auth/mfa/enroll', { headers });
  expect(enrol.status()).toBe(200);
  const { otpauthUrl } = (await enrol.json()) as { otpauthUrl: string };
  const secret = new URL(otpauthUrl).searchParams.get('secret')!;
  const verify = await http.post('/api/v1/auth/mfa/verify', {
    headers,
    data: { code: await nextUnusedCode(key, secret) },
  });
  expect(verify.status()).toBe(200);
  await http.dispose();
  const file = totpSecretFileOf(key);
  mkdirSync(new URL('.', file), { recursive: true });
  writeFileSync(file, secret);
}

for (const key of Object.keys(ACCOUNTS) as AccountKey[]) {
  setup(`sign in as ${key}`, async ({ browser }) => {
    if (isFirmRole(key)) await enrolMfa(key);
    const context = await browser.newContext({
      extraHTTPHeaders: { 'x-forwarded-for': addressOf(key) },
    });
    const page = await context.newPage();
    // The sign-in pages are checked (axe, brand, overflow) once, on the first firm user's two steps.
    await signIn(page, key, '/', key === 'firmAdmin' ? checkPage : undefined);
    await context.storageState({ path: storageStateOf(key) });
    await context.close();
  });
}
