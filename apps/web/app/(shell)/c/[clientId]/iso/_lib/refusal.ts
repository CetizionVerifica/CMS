// What an ISO page shows when the API refuses its data (docs/iso/plan.md §4.3-4.4): the add-on being set up (409
// FEATURE_NOT_READY until the account's catalogue copy is recorded), turned off since the shell last read the account
// (403 FEATURE_NOT_ENABLED), a role that can't read it, or a record the user can't see.
import { isApiError } from '../../../../../../lib/api/client';

export type Refusal = 'notReady' | 'notEnabled' | 'noPermission' | 'notFound';

/** The refusal an API error stands for, or undefined when it is not one a page words. */
export function refusalFor(error: unknown): Refusal | undefined {
  if (isApiError(error, 'FEATURE_NOT_READY')) return 'notReady';
  if (isApiError(error, 'FEATURE_NOT_ENABLED')) return 'notEnabled';
  if (isApiError(error, 'FORBIDDEN', 'ACCESS_EXPIRED')) return 'noPermission';
  if (isApiError(error, 'NOT_FOUND')) return 'notFound';
  return undefined;
}

/** The words a page and a failed action use while the add-on is being set up (plan §4.3). */
export const BEING_SET_UP = 'ISO management systems is being set up. Try again in a few minutes.';
