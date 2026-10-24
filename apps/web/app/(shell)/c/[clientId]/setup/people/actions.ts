'use server';
// Server Actions behind the people screen. Arguments are checked against the contracts' schemas first (root rule 7);
// the API checks access, keeps the person's status in step with their email and writes the audit events.
import { Id, MergeBody, PersonCreateBody, PersonUpdateBody } from '@canopy/contracts';
import { revalidatePath } from 'next/cache';

import { isApiError } from '../../../../../../lib/api/client';
import { sessionApi } from '../../../../../../lib/api/server';
import { membershipLines } from './people-model';

export type ActionResult<T = void> = { ok: true; value: T } | { ok: false; message: string };

function failure(error: unknown): { ok: false; message: string } {
  if (isApiError(error, 'DUPLICATE')) {
    return { ok: false, message: 'Someone in your firm already has this email.' };
  }
  if (isApiError(error, 'STALE_VERSION')) {
    return {
      ok: false,
      message:
        'Someone else changed this while you were editing. The page now shows their version.',
    };
  }
  if (isApiError(error, 'NOT_FOUND')) {
    return {
      ok: false,
      message: 'This person was removed or merged in the meantime. The page now shows who is left.',
    };
  }
  if (isApiError(error, 'FORBIDDEN', 'ACCESS_EXPIRED')) {
    return { ok: false, message: "You can no longer change this client's people." };
  }
  if (isApiError(error, 'VALIDATION')) {
    return {
      ok: false,
      message: 'This could not be saved. An active person keeps an email to sign in with.',
    };
  }
  throw error;
}

async function run<T>(clientId: string, change: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, value: await change() };
  } catch (error) {
    return failure(error);
  } finally {
    revalidatePath(`/c/${clientId}/setup/people`);
  }
}

export async function addPersonAction(
  clientId: string,
  input: { displayName: string; email: string | null; role: string },
): Promise<ActionResult> {
  const id = Id.parse(clientId);
  const body = PersonCreateBody.parse(input);
  return run(id, async () => {
    await (await sessionApi()).call('createClientPerson', { params: { clientId: id }, body });
  });
}

export async function updatePersonAction(
  clientId: string,
  personId: string,
  input: { version: number; displayName?: string; email?: string | null },
): Promise<ActionResult> {
  const id = Id.parse(clientId);
  const person = Id.parse(personId);
  const body = PersonUpdateBody.parse(input);
  return run(id, async () => {
    await (await sessionApi()).call('updatePerson', { params: { id: person }, body });
  });
}

export async function mergePeopleAction(
  clientId: string,
  targetId: string,
  input: { version: number; sourceIds: string[] },
): Promise<ActionResult> {
  const id = Id.parse(clientId);
  const target = Id.parse(targetId);
  const body = MergeBody.parse(input);
  if (body.sourceIds.includes(target)) throw new Error('A person cannot merge into themselves');
  return run(id, async () => {
    await (await sessionApi()).call('mergePeople', { params: { id: target }, body });
  });
}

/** What the person does in this client, in words, for the drawer. */
export async function rolesAction(
  clientId: string,
  personId: string,
): Promise<ActionResult<string[]>> {
  const id = Id.parse(clientId);
  const person = Id.parse(personId);
  try {
    const { data } = await (await sessionApi()).call('listMemberships', { params: { id: person } });
    return { ok: true, value: membershipLines(data.items, id) };
  } catch (error) {
    return failure(error);
  }
}
