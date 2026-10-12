// Which API answers: the real one at CANOPY_API_URL, or the in-process mock (mock.ts) while none is configured.
// Decided from the server's environment only, never from the request (a Host header is client-controlled). A
// production build uses the mock only when CANOPY_DEMO_API=1 says so (local e2e runs), so a deployment that forgot
// CANOPY_API_URL fails loudly instead of offering the demo accounts.
export type ApiMode = 'real' | 'mock';

type Env = { CANOPY_API_URL?: string; CANOPY_DEMO_API?: string; NODE_ENV?: string };

export function apiMode(env: Env): ApiMode {
  if (env.CANOPY_API_URL) return 'real';
  if (env.NODE_ENV !== 'production' || env.CANOPY_DEMO_API === '1') return 'mock';
  throw new Error('CANOPY_API_URL is not set. The demo API runs only with CANOPY_DEMO_API=1.');
}
