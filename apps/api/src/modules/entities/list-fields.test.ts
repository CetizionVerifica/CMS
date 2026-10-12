import { describe, expect, it } from 'vitest';
import { contextOf, ids, testApp } from './testing/world.js';
import { checkListFields } from './list-fields.js';

describe('list field allow-list', () => {
  it('accepts the fields each table allows', () => {
    expect(() =>
      checkListFields('people', {
        orderBy: 'nameNormalized',
        search: { fields: ['displayName', 'email'] },
      }),
    ).not.toThrow();
    expect(() => checkListFields('assignments', { orderBy: 'id' })).not.toThrow();
  });

  it('refuses any other sort or search field', () => {
    expect(() => checkListFields('people', { orderBy: 'email' })).toThrow(
      'people cannot be sorted by email',
    );
    expect(() =>
      checkListFields('clients', { orderBy: 'name', search: { fields: ['settings'] } }),
    ).toThrow('clients cannot be searched on settings');
  });

  it('is checked by the memory store too', async () => {
    const { store } = testApp();
    await expect(
      store.transaction(contextOf('firmAdmin'), (tx) =>
        tx.units.list({ orderBy: 'locationId', where: { clientId: ids.clientA }, limit: 5 }),
      ),
    ).rejects.toThrow('units cannot be sorted by locationId');
  });
});
