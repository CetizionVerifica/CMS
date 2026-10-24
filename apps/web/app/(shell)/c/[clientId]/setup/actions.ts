'use server';
// Server Actions behind the setup screens. Every argument comes from the browser, so each is checked against the
// contracts' schemas first (root rule 7); the API checks the person may change this client's setup and writes the
// audit events. Refusals come back as sentences for the page.
import {
  DepartmentCreateBody,
  DepartmentUpdateBody,
  Id,
  MergeBody,
  ReminderSettings,
} from '@canopy/contracts';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '../../../../../lib/api/client';
import { sessionApi } from '../../../../../lib/api/server';

export type ActionResult = { ok: true } | { ok: false; message: string };

const Version = z.int().min(1);

/** The person-facing sentence for a refused change; anything unexpected goes to the error boundary. */
function failure(error: unknown, duplicate: string): { ok: false; message: string } {
  if (isApiError(error, 'DUPLICATE')) return { ok: false, message: duplicate };
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
      message: 'This was removed in the meantime. The page now shows what is left.',
    };
  }
  if (isApiError(error, 'FORBIDDEN', 'ACCESS_EXPIRED')) {
    return { ok: false, message: "You can no longer change this client's setup." };
  }
  if (isApiError(error, 'VALIDATION')) {
    return { ok: false, message: 'These values could not be saved. Check them and try again.' };
  }
  throw error;
}

async function run(
  clientId: string,
  page: string,
  change: () => Promise<unknown>,
  duplicate = 'That name is already taken.',
): Promise<ActionResult> {
  try {
    await change();
    return { ok: true };
  } catch (error) {
    return failure(error, duplicate);
  } finally {
    // Refresh on a refusal too, so a stale form shows the current record.
    revalidatePath(`/c/${clientId}/setup/${page}`);
  }
}

const DEPARTMENT_TAKEN = 'This client already has a department with that name.';

export async function createDepartmentAction(
  clientId: string,
  input: { name: string; aliases: string[] },
): Promise<ActionResult> {
  const id = Id.parse(clientId);
  const body = DepartmentCreateBody.parse(input);
  return run(
    id,
    'departments',
    async () => (await sessionApi()).call('createDepartment', { params: { clientId: id }, body }),
    DEPARTMENT_TAKEN,
  );
}

export async function updateDepartmentAction(
  clientId: string,
  departmentId: string,
  input: { version: number; name?: string; aliases?: string[] },
): Promise<ActionResult> {
  const id = Id.parse(clientId);
  const dep = Id.parse(departmentId);
  const body = DepartmentUpdateBody.parse(input);
  return run(
    id,
    'departments',
    async () => (await sessionApi()).call('updateDepartment', { params: { id: dep }, body }),
    DEPARTMENT_TAKEN,
  );
}

export async function mergeDepartmentsAction(
  clientId: string,
  targetId: string,
  input: { version: number; sourceIds: string[] },
): Promise<ActionResult> {
  const id = Id.parse(clientId);
  const target = Id.parse(targetId);
  const body = MergeBody.parse(input);
  if (body.sourceIds.includes(target)) throw new Error('A department cannot merge into itself');
  return run(id, 'departments', async () =>
    (await sessionApi()).call('mergeDepartments', { params: { id: target }, body }),
  );
}

export async function saveRemindersAction(
  clientId: string,
  input: { version: number; reminders: ReminderSettings },
): Promise<ActionResult> {
  const id = Id.parse(clientId);
  const version = Version.parse(input.version);
  const reminders = ReminderSettings.parse(input.reminders);
  // Reminders only, so a client admin (who may change nothing else) can save them too.
  return run(id, 'reminders', async () =>
    (await sessionApi()).call('putClientSettings', {
      params: { clientId: id },
      body: { version, reminders },
    }),
  );
}
