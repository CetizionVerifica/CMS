import { describe, expect, it, vi } from 'vitest';

import { recentClients, rememberClient } from './recent';

describe('recent clients', () => {
  it('keeps the three most recent, newest first', () => {
    expect(recentClients()).toEqual([]);
    rememberClient('a');
    rememberClient('b');
    rememberClient('c');
    rememberClient('a');
    expect(rememberClient('d')).toEqual(['d', 'a', 'c']);
    expect(recentClients()).toEqual(['d', 'a', 'c']);
  });

  it('survives junk and blocked storage', () => {
    window.localStorage.setItem('pp.recentClients', '{"not":"a list"}');
    expect(recentClients()).toEqual([]);
    window.localStorage.setItem('pp.recentClients', 'not json');
    expect(recentClients()).toEqual([]);
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(rememberClient('x')).toEqual(['x']);
    spy.mockRestore();
  });
});
