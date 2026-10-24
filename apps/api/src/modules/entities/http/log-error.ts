/**
 * What an unhandled M6 error may put in the logs (root rule 6). A copy of M5's `loggableError` (auth/log-error.ts,
 * #141), kept in M6's paths because modules share code only through contracts.
 *
 * A Postgres error's `message`, `detail`, `where` and `hint` can quote row values, such as the email in a unique
 * violation, and a failed query's message carries its parameters. So database errors log only their code and the
 * names of what failed, other messages drop anything from a `params:` line on, and the stack keeps only its frames.
 * Causes are followed a few levels deep.
 */
export interface LoggedError {
  readonly type: string;
  readonly message?: string;
  readonly code?: string;
  readonly table?: string;
  readonly column?: string;
  readonly constraint?: string;
  readonly routine?: string;
  readonly stack?: string;
  readonly cause?: LoggedError;
}

const PG_NAMES = ['table', 'column', 'constraint', 'routine'] as const;
const MAX_DEPTH = 5;

export function loggableError(error: unknown, depth = 0): LoggedError {
  if (!(error instanceof Error)) return { type: typeof error };
  const fields = error as Error & Record<string, unknown>;
  const code = typeof fields.code === 'string' ? fields.code : undefined;
  const fromPostgres = code !== undefined && /^[0-9A-Z]{5}$/.test(code);
  const logged: Record<string, unknown> = { type: error.name };
  if (!fromPostgres) logged.message = error.message.split(/\nparams:/)[0];
  if (code !== undefined) logged.code = code;
  if (fromPostgres) {
    for (const name of PG_NAMES) {
      if (typeof fields[name] === 'string') logged[name] = fields[name];
    }
  }
  const frames = error.stack
    ?.split('\n')
    .filter((line) => line.trimStart().startsWith('at '))
    .join('\n');
  if (frames) logged.stack = frames;
  if (error.cause !== undefined && depth < MAX_DEPTH)
    logged.cause = loggableError(error.cause, depth + 1);
  return logged as unknown as LoggedError;
}
