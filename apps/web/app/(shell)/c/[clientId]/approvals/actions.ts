'use server';
// Server Actions behind the approvals inbox. Every argument comes from the browser, so each is checked against the
// contracts' schemas first (root rule 7); the API then checks the person's access to the client. Approve and send back
// go through the instance drawer's runInstanceAction, so both places send the same bodies.
import { ActivitySource, Cursor, Id } from '@canopy/contracts';
import { z } from 'zod';

import { serverApi } from '../../../../../lib/api/server';
import { loadQueue, type ApprovalsPage } from './_lib/approvals-api';

const Scope = z.enum(['mine', 'client']);

export async function loadMoreApprovals(
  clientId: string,
  scope: 'mine' | 'client',
  cursor: string,
  source?: ActivitySource,
): Promise<ApprovalsPage> {
  return loadQueue(
    await serverApi(),
    Id.parse(clientId),
    Scope.parse(scope),
    Cursor.parse(cursor),
    ActivitySource.optional().parse(source),
  );
}
