// The override's note, read back from the operator audit, so that saving limits or switching an add-on keeps it.
import { noteFrom } from '../../account-actions';
import type { OperatorClient } from '../../api';

export async function overrideNote(api: OperatorClient, accountId: string): Promise<string | null> {
  const { items } = await api.call('listOperatorAudit', {
    query: { accountId, action: 'OVERRIDE_CHANGE', limit: '1' },
  });
  return noteFrom(items[0]);
}
