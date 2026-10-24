import { test as setup } from '@playwright/test';

import { signIn } from './helpers.js';
import { ACCOUNTS, addressOf, storageStateOf, type AccountKey } from './stack.js';

// Signs every seeded account in once through the real login page (and MFA for firm roles), and saves the browser
// state the journeys reuse. The import journey runs first among the specs because the others need its register.
for (const key of Object.keys(ACCOUNTS) as AccountKey[]) {
  setup(`sign in as ${key}`, async ({ browser }) => {
    const context = await browser.newContext({
      extraHTTPHeaders: { 'x-forwarded-for': addressOf(key) },
    });
    const page = await context.newPage();
    await signIn(page, key);
    await context.storageState({ path: storageStateOf(key) });
    await context.close();
  });
}
