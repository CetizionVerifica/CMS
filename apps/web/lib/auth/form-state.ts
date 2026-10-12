// Result of an auth form's Server Action, read by the form with useActionState.
import type { z } from 'zod';

// `values` echoes what was typed (never passwords): React resets a form after its action runs, so the fields show
// these again instead of coming back empty.
type Values = { values?: Record<string, string> };

export type FormState =
  | ({ status: 'idle' } & Values)
  | ({ status: 'invalid'; fieldErrors: Record<string, string> } & Values)
  | ({ status: 'error'; message: string } & Values)
  | ({ status: 'done'; message: string } & Values);

export const IDLE: FormState = { status: 'idle' };

/** First message per field, keyed by the field name. `messages` replaces the schema's text for the fields it names. */
export function fieldErrors(
  error: z.ZodError,
  messages: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form');
    out[key] ??= messages[key] ?? issue.message;
  }
  return out;
}
