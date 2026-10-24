import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const { clearSessionCaches, forgetSession, sessionCache } = await import('./session-cache');

describe('session cache', () => {
  beforeEach(() => clearSessionCaches());

  it('answers the same session until the entry expires', () => {
    let time = 1_000;
    const cache = sessionCache<string>('ttl', 5_000, () => time);
    cache.set('pp_session=a', 'Owner A');
    expect(cache.get('pp_session=a')).toBe('Owner A');
    time += 4_999;
    expect(cache.get('pp_session=a')).toBe('Owner A');
    time += 1;
    expect(cache.get('pp_session=a')).toBeUndefined();
  });

  it('never answers another session', () => {
    const cache = sessionCache<string>('isolation', 5_000);
    cache.set('pp_session=a', 'Owner A');
    expect(cache.get('pp_session=b')).toBeUndefined();
    expect(cache.get('pp_session=a; pp_layout=rail')).toBeUndefined();
  });

  it('forgets a session in every cache, and clears all', () => {
    const one = sessionCache<string>('one', 5_000);
    const two = sessionCache<number>('two', 5_000);
    one.set('pp_session=a', 'Owner A');
    two.set('pp_session=a', 3);
    one.set('pp_session=b', 'Owner B');
    forgetSession('pp_session=a');
    expect(one.get('pp_session=a')).toBeUndefined();
    expect(two.get('pp_session=a')).toBeUndefined();
    expect(one.get('pp_session=b')).toBe('Owner B');
    clearSessionCaches();
    expect(one.get('pp_session=b')).toBeUndefined();
  });

  it('shares entries with another copy of the module, as Next loads one for renders and one for actions', async () => {
    const render = sessionCache<string>('me', 5_000);
    render.set('pp_session=a', 'Consultant before MFA');
    vi.resetModules();
    const actions = await import('./session-cache');
    expect(actions).not.toHaveProperty('sessionCache', sessionCache);
    expect(actions.sessionCache<string>('me', 5_000).get('pp_session=a')).toBe(
      'Consultant before MFA',
    );
    actions.forgetSession('pp_session=a');
    expect(render.get('pp_session=a')).toBeUndefined();
  });

  it('stays bounded, dropping expired entries first, then the oldest', () => {
    let time = 0;
    const cache = sessionCache<number>('bounded', 10, () => time);
    cache.set('expired', 0);
    time = 5;
    for (let i = 1; i < 1000; i++) cache.set(`s${i}`, i);
    time = 12;
    cache.set('new', 1000);
    expect(cache.get('expired')).toBeUndefined();
    expect(cache.get('s1')).toBe(1);
    time = 14;
    cache.set('newer', 1001);
    expect(cache.get('s1')).toBeUndefined();
    expect(cache.get('s2')).toBe(2);
    expect(cache.get('newer')).toBe(1001);
  });
});
