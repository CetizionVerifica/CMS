import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../../../../lib/api/client';
import { confirmUpload, suggestedFor } from './import-api';

const BATCH = '00000000-0000-5000-8000-0000000000b1';

function fakeApi(sheets: { name: string; headers: string[] }[]) {
  const call = vi.fn(async (name: string) =>
    name === 'importUploaded'
      ? { data: { sheets, suggestedMapping: [{ sourceHeader: 'Due Date', field: 'dueDate' }] } }
      : { data: {} },
  );
  return { api: { call } as unknown as ApiClient, call };
}

describe('confirmUpload', () => {
  it('saves the suggested mapping for the first sheet', async () => {
    const { api, call } = fakeApi([{ name: 'Register', headers: ['Due Date', ' ', 'Notes'] }]);
    await confirmUpload(api, BATCH, 'a'.repeat(64));
    expect(call).toHaveBeenLastCalledWith('putImportMapping', {
      params: { id: BATCH },
      body: {
        sheetName: 'Register',
        mapping: [
          { sourceHeader: 'Due Date', field: 'dueDate' },
          { sourceHeader: 'Notes', field: null },
        ],
      },
    });
  });

  it('saves no mapping for a workbook without a sheet', async () => {
    const { api, call } = fakeApi([]);
    const data = await confirmUpload(api, BATCH, 'a'.repeat(64));
    expect(data.sheets).toEqual([]);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('ignores columns the suggestion leaves out', () => {
    expect(suggestedFor(['A'], null)).toEqual([{ sourceHeader: 'A', field: null }]);
  });
});
