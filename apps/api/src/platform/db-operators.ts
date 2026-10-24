import { createInterface } from 'node:readline';
import { Email, Name, type PlatformOperator } from '@canopy/contracts';
import { createOperatorDatabase, operators, type OperatorDatabase } from '@canopy/db';
import { z } from 'zod';
import { hashPassword, newTotpSecret, otpauthUri, SecretBox } from '../auth/index.js';

const NewOperatorInput = z.strictObject({
  email: Email,
  displayName: Name,
  /** As long as a customer's (M5): 12 to 200 characters. */
  password: z.string().min(12).max(200),
});
export type NewOperatorInput = z.infer<typeof NewOperatorInput>;

export interface AddedOperator {
  operator: PlatformOperator;
  /** For the authenticator app, shown once by the CLI. Never logged or stored unsealed. */
  otpauthUri: string;
}

/**
 * Creates an operator with their password and a new TOTP secret, sealed with M5's secret box. The only way an
 * operator is made: no route creates one (ADR M15-0001 decision 9).
 */
export async function addOperator(
  db: OperatorDatabase,
  secrets: SecretBox,
  input: NewOperatorInput,
): Promise<AddedOperator> {
  const n = NewOperatorInput.parse(input);
  const secret = newTotpSecret();
  const operator = await db.withOperator('platform:add-operator', async (tx) =>
    operators.create(tx, {
      email: n.email,
      displayName: n.displayName,
      passwordHash: await hashPassword(n.password),
      mfaSealedSecret: secrets.seal(secret),
    }),
  );
  return { operator, otpauthUri: otpauthUri(secret, n.email) };
}

/**
 * `pnpm --filter @canopy/api platform:add-operator --email <email> --name <name>`, with the password on stdin.
 * Needs OPERATOR_DATABASE_URL and AUTH_SECRET_KEY. Prints the otpauth URI to add to an authenticator app.
 */
export async function runAddOperator(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  io: { stdin: NodeJS.ReadableStream; out: (line: string) => void },
): Promise<void> {
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const email = flag('email');
  const displayName = flag('name');
  if (!email || !displayName) {
    throw new Error(
      'Usage: platform:add-operator --email <email> --name <name> (password on stdin)',
    );
  }
  const url = env.OPERATOR_DATABASE_URL;
  const key = env.AUTH_SECRET_KEY;
  if (!url || !key) throw new Error('Set OPERATOR_DATABASE_URL and AUTH_SECRET_KEY');
  const password = await firstLine(io.stdin);
  const db = createOperatorDatabase({ connectionString: url, max: 1 });
  try {
    const added = await addOperator(db, new SecretBox(key), { email, displayName, password });
    io.out(`Operator ${added.operator.email} created (${added.operator.id}).`);
    io.out('Add this to an authenticator app now; it is not shown again:');
    io.out(added.otpauthUri);
  } finally {
    await db.close();
  }
}

async function firstLine(stdin: NodeJS.ReadableStream): Promise<string> {
  const lines = createInterface({ input: stdin, terminal: false });
  for await (const line of lines) {
    lines.close();
    return line;
  }
  return '';
}
