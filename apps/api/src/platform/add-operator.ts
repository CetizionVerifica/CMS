// `pnpm --filter @canopy/api platform:add-operator --email <email> --name <name>`, password on stdin.
import { runAddOperator } from './db-operators.js';

runAddOperator(process.argv.slice(2), process.env, {
  stdin: process.stdin,
  out: (line) => process.stdout.write(`${line}\n`),
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
