// What a failed ISO call says to the person who made it. Keyed by the API's error code (api-conventions.md §4), never
// by its message, except that a VALIDATION message names the field the API refused.
import type { ErrorCode } from '@canopy/contracts';

import { BEING_SET_UP } from './refusal';

export type Outcome<T> =
  { ok: true; data: T } | { ok: false; code: ErrorCode | 'UNKNOWN'; message: string };

export function failureMessage(code: ErrorCode | 'UNKNOWN', apiMessage = ''): string {
  switch (code) {
    case 'STALE_VERSION':
      return 'Someone else changed this while you were working on it. The page now shows their version.';
    case 'INVALID_TRANSITION':
      return 'This has moved on since the page loaded. The page now shows where it stands.';
    case 'REASON_REQUIRED':
      return 'Give a reason for this change.';
    case 'DUPLICATE':
      return 'That is already in use. Choose another.';
    case 'NOT_FOUND':
      return 'This was removed or is no longer yours to see.';
    case 'FORBIDDEN':
    case 'ACCESS_EXPIRED':
      return 'You can’t do this here. Ask your client admin if you need to.';
    case 'FEATURE_NOT_READY':
      return BEING_SET_UP;
    case 'FEATURE_NOT_ENABLED':
      return 'ISO management systems is not turned on for your account.';
    case 'VALIDATION':
      return apiMessage
        ? `This can’t be saved yet: ${apiMessage}`
        : 'Check the form and try again.';
    default:
      return 'Something went wrong. Try again, and if it keeps happening, contact support.';
  }
}
