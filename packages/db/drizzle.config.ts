import { defineConfig } from 'drizzle-kit';

// `pnpm db:generate` writes a migration from the schema diff. Review every generated file by hand
// (packages/db/CLAUDE.md rule 8); functions, grants and triggers live in custom migrations.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  strict: true,
  verbose: true,
  entities: { roles: false },
});
