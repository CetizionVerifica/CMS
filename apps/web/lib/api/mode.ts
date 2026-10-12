// Which API answers: the real one at CANOPY_API_URL, or the in-process mock (mock.ts) while none is configured.
// A production server reached on a real host name never falls back to the mock: a deployment that forgot
// CANOPY_API_URL fails loudly instead of offering the demo accounts.
export type ApiMode = 'real' | 'mock';

type Env = { CANOPY_API_URL?: string; NODE_ENV?: string };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function apiMode(env: Env, host: string | null): ApiMode {
  if (env.CANOPY_API_URL) return 'real';
  if (env.NODE_ENV !== 'production') return 'mock';
  const hostname = (host ?? '').toLowerCase().replace(/:\d+$/, '');
  if (LOCAL_HOSTS.has(hostname)) return 'mock';
  throw new Error('CANOPY_API_URL is not set. The demo API only runs locally.');
}
