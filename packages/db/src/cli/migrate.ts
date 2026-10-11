// `pnpm db:migrate`: applies pending migrations as the connecting (owner) user.
import { createAdminDatabase } from '../database.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
const admin = createAdminDatabase({ connectionString });
try {
  await admin.migrate();
  console.log('Migrations applied.');
} finally {
  await admin.close();
}
